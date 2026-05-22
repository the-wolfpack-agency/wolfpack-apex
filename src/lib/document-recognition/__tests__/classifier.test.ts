/**
 * classifier unit tests.
 *
 * Strategy: inject a fake VisionCaller into classifyDocument so we never
 * touch the network. We exercise:
 *   - happy path: every DocumentType round-trips through the validator
 *   - structural validation: invalid type / confidence / rationale length /
 *     alternates shape all reject with ClassifierMalformedOutputError
 *   - operational errors: missing ANTHROPIC_API_KEY → NotConfigured,
 *     AI returns null → AIUnavailable, unsupported MIME → UnsupportedMime
 *   - cost is computed from token counts using the pinned Haiku constants
 *   - latencyMs >= 0
 *   - image vs PDF dispatch: PDF inputs produce a "document" block, all
 *     other supported MIMEs produce an "image" block
 *   - alternates are sorted descending by confidence even when the model
 *     returned them out of order
 */

import {
  classifyDocument,
  defaultVisionCaller,
  CLASSIFIER_MODEL,
  ClassifierAIUnavailableError,
  ClassifierMalformedOutputError,
  ClassifierNotConfiguredError,
  ClassifierUnsupportedMimeError,
  type VisionCallInput,
  type VisionCaller,
} from "@/lib/document-recognition/classifier";
import type {
  ClassifierCandidate,
  DocumentType,
} from "@/lib/document-recognition/types";

/* --------------------------- Test fixtures ---------------------------- */

const SAMPLE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

interface GoodOutput {
  type: DocumentType;
  confidence: number;
  alternates: ClassifierCandidate[];
  rationale: string;
}

function goodOutput(overrides: Partial<GoodOutput> = {}): string {
  const obj: GoodOutput = {
    type: "receipt",
    confidence: 0.93,
    alternates: [
      { type: "invoice", confidence: 0.4 },
      { type: "unknown", confidence: 0.05 },
    ],
    rationale: "Itemized list of products with prices and a total at the bottom.",
    ...overrides,
  };
  return JSON.stringify(obj);
}

function stubVision(
  content: string,
  tokensIn = 500,
  tokensOut = 200,
): VisionCaller {
  return async () => ({
    content,
    tokensIn,
    tokensOut,
    model: CLASSIFIER_MODEL,
  });
}

/** Spy vision caller — records the last input passed in. */
function spyVision(content: string): {
  ai: VisionCaller;
  last: () => VisionCallInput | null;
} {
  let captured: VisionCallInput | null = null;
  const ai: VisionCaller = async (input) => {
    captured = input;
    return {
      content,
      tokensIn: 500,
      tokensOut: 200,
      model: CLASSIFIER_MODEL,
    };
  };
  return { ai, last: () => captured };
}

/* ------------------------------- Tests -------------------------------- */

describe("classifyDocument — happy path", () => {
  it("returns a fully populated DocumentClassification", async () => {
    const ai = stubVision(goodOutput());
    const result = await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });

    expect(result.type).toBe("receipt");
    expect(result.confidence).toBeCloseTo(0.93, 5);
    expect(result.alternates).toHaveLength(2);
    expect(result.alternates[0].type).toBe("invoice");
    expect(result.alternates[0].confidence).toBeCloseTo(0.4, 5);
    expect(result.alternates[1].type).toBe("unknown");
    expect(result.rationale.length).toBeLessThanOrEqual(240);
    expect(result.model).toBe(CLASSIFIER_MODEL);
    expect(typeof result.latencyMs).toBe("number");
    expect(typeof result.costCents).toBe("number");
  });

  it("sorts alternates descending by confidence when model returned them out of order", async () => {
    const ai = stubVision(
      goodOutput({
        alternates: [
          { type: "tax_w2", confidence: 0.1 },
          { type: "invoice", confidence: 0.55 },
          { type: "unknown", confidence: 0.3 },
        ],
      }),
    );
    const result = await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });

    expect(result.alternates.map((a) => a.type)).toEqual([
      "invoice",
      "unknown",
      "tax_w2",
    ]);
    // Descending invariant.
    for (let i = 1; i < result.alternates.length; i++) {
      expect(result.alternates[i - 1].confidence).toBeGreaterThanOrEqual(
        result.alternates[i].confidence,
      );
    }
  });

  it("strips ```json fences from model output", async () => {
    const ai = stubVision("```json\n" + goodOutput() + "\n```");
    const result = await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });
    expect(result.type).toBe("receipt");
  });
});

describe("classifyDocument — every document type round-trips", () => {
  const TYPES: DocumentType[] = [
    "receipt",
    "invoice",
    "tax_w2",
    "tax_1099",
    "id_document",
    "unknown",
  ];

  for (const t of TYPES) {
    it(`accepts type "${t}"`, async () => {
      const ai = stubVision(
        goodOutput({
          type: t,
          confidence: 0.8,
          // Alternates must never repeat the top-pick — pick a sibling.
          alternates: [
            { type: t === "unknown" ? "receipt" : "unknown", confidence: 0.1 },
          ],
          rationale: `Matches the visual pattern of a ${t}.`,
        }),
      );
      const result = await classifyDocument({
        bytes: SAMPLE_BYTES,
        mime: "image/png",
        ai,
      });
      expect(result.type).toBe(t);
    });
  }
});

describe("classifyDocument — validation rejects bad model output", () => {
  it("rejects unknown document type (e.g. 'unicorn_certificate')", async () => {
    const ai = stubVision(
      JSON.stringify({
        type: "unicorn_certificate",
        confidence: 0.9,
        alternates: [],
        rationale: "Sparkles.",
      }),
    );
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });

  it("rejects confidence > 1", async () => {
    const ai = stubVision(goodOutput({ confidence: 1.5 }));
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });

  it("rejects negative confidence", async () => {
    const ai = stubVision(goodOutput({ confidence: -0.1 }));
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });

  it("rejects rationale > 240 chars", async () => {
    const ai = stubVision(goodOutput({ rationale: "x".repeat(241) }));
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });

  it("rejects malformed alternates entry", async () => {
    const ai = stubVision(
      JSON.stringify({
        type: "receipt",
        confidence: 0.8,
        alternates: [{ type: "invoice" /* missing confidence */ }],
        rationale: "Looks like a receipt.",
      }),
    );
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });

  it("rejects alternates that repeat the top-pick type", async () => {
    const ai = stubVision(
      goodOutput({
        alternates: [{ type: "receipt", confidence: 0.4 }],
      }),
    );
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });

  it("rejects more than 3 alternates", async () => {
    const ai = stubVision(
      goodOutput({
        alternates: [
          { type: "invoice", confidence: 0.3 },
          { type: "tax_w2", confidence: 0.2 },
          { type: "tax_1099", confidence: 0.15 },
          { type: "unknown", confidence: 0.05 },
        ],
      }),
    );
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });

  it("rejects non-JSON model content", async () => {
    const ai = stubVision("totally not json");
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });

  it("rejects JSON that is not an object (e.g. array)", async () => {
    const ai = stubVision(JSON.stringify(["receipt"]));
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierMalformedOutputError);
  });
});

describe("classifyDocument — operational errors", () => {
  it("throws ClassifierUnsupportedMimeError for unsupported MIME", async () => {
    const ai = stubVision(goodOutput());
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "text/plain", ai }),
    ).rejects.toBeInstanceOf(ClassifierUnsupportedMimeError);
  });

  it("throws ClassifierAIUnavailableError when the AI returns null", async () => {
    const ai: VisionCaller = async () => null;
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierAIUnavailableError);
  });

  it("throws ClassifierAIUnavailableError when the AI throws a non-config error", async () => {
    const ai: VisionCaller = async () => {
      throw new Error("network down");
    };
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierAIUnavailableError);
  });

  it("propagates ClassifierNotConfiguredError from the AI caller", async () => {
    const ai: VisionCaller = async () => {
      throw new ClassifierNotConfiguredError();
    };
    await expect(
      classifyDocument({ bytes: SAMPLE_BYTES, mime: "image/png", ai }),
    ).rejects.toBeInstanceOf(ClassifierNotConfiguredError);
  });

  it("defaultVisionCaller throws ClassifierNotConfiguredError when ANTHROPIC_API_KEY is missing", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(
        defaultVisionCaller({
          systemPrompt: "x",
          userText: "y",
          block: {
            kind: "image",
            mediaType: "image/png",
            base64Data: "AAAA",
          },
        }),
      ).rejects.toBeInstanceOf(ClassifierNotConfiguredError);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe("classifyDocument — vision block dispatch", () => {
  it("sends a document block for application/pdf", async () => {
    const { ai, last } = spyVision(goodOutput());
    await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "application/pdf",
      ai,
    });
    const call = last();
    expect(call).not.toBeNull();
    expect(call!.block.kind).toBe("document");
    expect(call!.block.mediaType).toBe("application/pdf");
  });

  it("sends an image block for image/png", async () => {
    const { ai, last } = spyVision(goodOutput());
    await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });
    const call = last();
    expect(call).not.toBeNull();
    expect(call!.block.kind).toBe("image");
    expect(call!.block.mediaType).toBe("image/png");
  });

  it("sends an image block for image/jpeg", async () => {
    const { ai, last } = spyVision(goodOutput());
    await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/jpeg",
      ai,
    });
    expect(last()!.block.kind).toBe("image");
  });

  it("encodes bytes as base64 in the block", async () => {
    const { ai, last } = spyVision(goodOutput());
    await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });
    const expected = Buffer.from(SAMPLE_BYTES).toString("base64");
    expect(last()!.block.base64Data).toBe(expected);
  });
});

describe("classifyDocument — metrics", () => {
  it("computes costCents from token counts using the pinned Haiku constants", async () => {
    // 1,000,000 input tokens × $1.00/M  = $1.00 = 100¢
    //   200,000 output tokens × $5.00/M = $1.00 = 100¢
    // total = 200¢
    const ai = stubVision(goodOutput(), 1_000_000, 200_000);
    const result = await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });
    expect(result.costCents).toBe(200);
  });

  it("yields costCents = 0 when no tokens were billed", async () => {
    const ai = stubVision(goodOutput(), 0, 0);
    const result = await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });
    expect(result.costCents).toBe(0);
  });

  it("reports latencyMs >= 0", async () => {
    const ai = stubVision(goodOutput());
    const result = await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves the model id returned by the caller", async () => {
    const customModel = "claude-haiku-4-5-test-build";
    const ai: VisionCaller = async () => ({
      content: goodOutput(),
      tokensIn: 100,
      tokensOut: 50,
      model: customModel,
    });
    const result = await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });
    expect(result.model).toBe(customModel);
  });

  it("falls back to the pinned model id when the caller omits one", async () => {
    const ai: VisionCaller = async () => ({
      content: goodOutput(),
      tokensIn: 100,
      tokensOut: 50,
      model: "",
    });
    const result = await classifyDocument({
      bytes: SAMPLE_BYTES,
      mime: "image/png",
      ai,
    });
    expect(result.model).toBe(CLASSIFIER_MODEL);
  });
});
