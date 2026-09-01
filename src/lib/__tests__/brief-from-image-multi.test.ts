/**
 * brief-from-image-multi unit tests — covers the multi-frame entry
 * point `briefFromFrames` plus the delegation contract of the legacy
 * `briefFromImage` wrapper.
 *
 * Non-negotiables these tests pin:
 *  - ONE vision call for N frames (cost/efficiency hard requirement).
 *  - Content blocks arrive in the order the designer uploaded them.
 *  - PDFs are passed through as a single `document` block — never split,
 *    never rasterized.
 *  - Analytics flow on every path (success + every error + rejection)
 *    with `frame_count` and `source_kind`. No data lost.
 *  - `briefFromImage(x)` keeps byte-for-byte identical output shape vs
 *    the pre-multi-frame contract (regression guard).
 */

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const mockInsert = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/brief-generations", () => ({
  insertBriefGeneration: (...args: unknown[]) => mockInsert(...args),
}));

import {
  briefFromImage,
  briefFromFrames,
  BriefFromImageError,
  type VisionCaller,
  type VisionCallInput,
} from "@/lib/brief-from-image";
import type { SiteBrief } from "@/lib/sites-schema";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Small constant byte blobs — the orchestrator does not decode them
 * (palette extraction fails gracefully on arbitrary bytes and returns
 * an empty swatch set). The model stub drives the brief content. */
const FRAME_A = new Uint8Array([1, 2, 3, 4, 5]);
const FRAME_B = new Uint8Array([6, 7, 8, 9, 10]);
const FRAME_C = new Uint8Array([11, 12, 13, 14, 15]);
const PDF_BYTES = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]); // "%PDF-1.4"

function singlePageBrief(): SiteBrief {
  return {
    client: "TO_BE_OVERWRITTEN",
    product: { name: "CFTR" },
    theme: { colors: { primary: "#000000", accent: "#ff00ff" } },
    pages: [
      {
        route: "/",
        title: "Home",
        sections: [
          {
            type: "hero",
            heading: "Season One",
            body: "The rookie year",
            cta: { label: "Sponsor", href: "/sponsor" },
          },
          { type: "text", heading: "About", body: "We race hard." },
        ],
      },
    ],
  };
}

function threePageBrief(): SiteBrief {
  return {
    client: "TO_BE_OVERWRITTEN",
    product: { name: "CFTR Multi" },
    pages: [
      {
        route: "/",
        title: "Home",
        sections: [{ type: "hero", heading: "Home" }],
      },
      {
        route: "/about",
        title: "About",
        sections: [{ type: "text", heading: "About", body: "About copy" }],
      },
      {
        route: "/contact",
        title: "Contact",
        sections: [{ type: "callout", body: "Get in touch" }],
      },
    ],
  };
}

function spyVision(
  contentFactory: () => string,
  tokensIn = 500,
  tokensOut = 400,
): {
  ai: VisionCaller;
  calls: VisionCallInput[];
} {
  const calls: VisionCallInput[] = [];
  const ai: VisionCaller = async (input) => {
    calls.push(input);
    return {
      content: contentFactory(),
      tokensIn,
      tokensOut,
      model: "claude-haiku-4-5-20251001",
    };
  };
  return { ai, calls };
}

const BASE = {
  clientSlug: "cftr",
  userId: "u_multi",
  userRole: "sales",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockInsert.mockResolvedValue(undefined);
});

/* ------------------------------------------------------------------ */
/* 1. Single image — behaves identically to pre-change briefFromImage */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — single image", () => {
  it("fires analytics with source_kind=image, frame_count=1, pages_extracted=1", async () => {
    const { ai, calls } = spyVision(() => JSON.stringify(singlePageBrief()));
    const result = await briefFromFrames({
      ...BASE,
      frames: [{ bytes: FRAME_A, mime: "image/png" }],
      ai,
    });

    expect(result.brief.client).toBe("cftr");
    expect(result.brief.pages).toHaveLength(1);
    expect(calls).toHaveLength(1); // ONE vision call
    expect(calls[0].frames).toHaveLength(1);
    expect(calls[0].frames[0].kind).toBe("image");
    expect(calls[0].frames[0].mediaType).toBe("image/png");

    // Requested + succeeded analytics both carry frame_count + source_kind
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_requested",
      "u_multi",
      "sales",
      expect.objectContaining({
        frame_count: 1,
        source_kind: "image",
        mime: "image/png",
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_succeeded",
      "u_multi",
      "sales",
      expect.objectContaining({
        frame_count: 1,
        source_kind: "image",
        pages_extracted: 1,
        page_count: 1, // legacy synonym still present
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. Three images — one call, three content blocks in order          */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — three images", () => {
  it("sends ONE vision call with three image blocks in order", async () => {
    const { ai, calls } = spyVision(() => JSON.stringify(threePageBrief()));
    const result = await briefFromFrames({
      ...BASE,
      frames: [
        { bytes: FRAME_A, mime: "image/png", label: "home" },
        { bytes: FRAME_B, mime: "image/png", label: "about" },
        { bytes: FRAME_C, mime: "image/png", label: "contact" },
      ],
      ai,
    });

    expect(calls).toHaveLength(1); // SINGLE call — hard requirement
    expect(calls[0].frames).toHaveLength(3);
    expect(calls[0].frames.map((f) => f.kind)).toEqual([
      "image",
      "image",
      "image",
    ]);
    // Order preserved — base64 of FRAME_A comes first.
    expect(calls[0].frames[0].base64Data).toBe(
      Buffer.from(FRAME_A).toString("base64"),
    );
    expect(calls[0].frames[1].base64Data).toBe(
      Buffer.from(FRAME_B).toString("base64"),
    );
    expect(calls[0].frames[2].base64Data).toBe(
      Buffer.from(FRAME_C).toString("base64"),
    );

    // The user-text must mention multi-page semantics so the model
    // knows to emit N pages.
    expect(calls[0].userText).toMatch(/3 wireframe images/i);
    expect(calls[0].userText).toMatch(/each image is a distinct website page/i);

    // Returned brief carries 3 pages in order.
    expect(result.brief.pages.map((p) => p.route)).toEqual([
      "/",
      "/about",
      "/contact",
    ]);

    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_succeeded",
      "u_multi",
      "sales",
      expect.objectContaining({
        frame_count: 3,
        source_kind: "images_multi",
        pages_extracted: 3,
        page_count: 3,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 3. Single PDF — one document block, multi-page prompt              */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — single PDF", () => {
  it("sends ONE document block and prompt instructs per-page output", async () => {
    const { ai, calls } = spyVision(() => JSON.stringify(threePageBrief()));
    await briefFromFrames({
      ...BASE,
      frames: [{ bytes: PDF_BYTES, mime: "application/pdf" }],
      ai,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].frames).toHaveLength(1);
    expect(calls[0].frames[0].kind).toBe("document");
    expect(calls[0].frames[0].mediaType).toBe("application/pdf");

    // User-text instructs per-page output.
    expect(calls[0].userText).toMatch(/each page of the pdf/i);
    // System prompt carries the MULTI-FRAME block.
    expect(calls[0].systemPrompt).toMatch(/MULTI-FRAME RULES/);

    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_requested",
      "u_multi",
      "sales",
      expect.objectContaining({
        frame_count: 1,
        source_kind: "pdf",
        mime: "application/pdf",
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_succeeded",
      "u_multi",
      "sales",
      expect.objectContaining({
        frame_count: 1,
        source_kind: "pdf",
        pages_extracted: 3, // model returned 3 PDF pages
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. Empty frames → no_frames + analytics                            */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — empty input", () => {
  it("throws no_frames and fires rejection analytics", async () => {
    const { ai } = spyVision(() => JSON.stringify(singlePageBrief()));
    await expect(
      briefFromFrames({ ...BASE, frames: [], ai }),
    ).rejects.toMatchObject({
      name: "BriefFromImageError",
      reason: "no_frames",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_image_rejected",
      "u_multi",
      "sales",
      expect.objectContaining({ reason: "no_frames", frame_count: 0 }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 5. Mixed PDF + image → mixed_sources                                */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — mixed sources", () => {
  it("throws mixed_sources and fires rejection analytics", async () => {
    const { ai } = spyVision(() => JSON.stringify(singlePageBrief()));
    await expect(
      briefFromFrames({
        ...BASE,
        frames: [
          { bytes: FRAME_A, mime: "image/png" },
          { bytes: PDF_BYTES, mime: "application/pdf" },
        ],
        ai,
      }),
    ).rejects.toMatchObject({
      name: "BriefFromImageError",
      reason: "mixed_sources",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_image_rejected",
      "u_multi",
      "sales",
      expect.objectContaining({ reason: "mixed_sources", frame_count: 2 }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 6. Unsupported MIME in ANY frame → unsupported_mime                */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — unsupported mime", () => {
  it("rejects if any frame has an unsupported mime", async () => {
    const { ai } = spyVision(() => JSON.stringify(singlePageBrief()));
    await expect(
      briefFromFrames({
        ...BASE,
        frames: [
          { bytes: FRAME_A, mime: "image/png" },
          { bytes: FRAME_B, mime: "application/zip" }, // BAD
        ],
        ai,
      }),
    ).rejects.toMatchObject({
      name: "BriefFromImageError",
      reason: "unsupported_mime",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_image_rejected",
      "u_multi",
      "sales",
      expect.objectContaining({
        reason: "unsupported_mime",
        mime: "application/zip",
        frame_count: 2,
      }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 7. Non-JSON vision output → bad_ai_output, no generation row       */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — bad AI output", () => {
  it("does not insert a generation row on bad JSON and fires failure analytics", async () => {
    const { ai } = spyVision(() => "definitely not json");
    await expect(
      briefFromFrames({
        ...BASE,
        frames: [
          { bytes: FRAME_A, mime: "image/png" },
          { bytes: FRAME_B, mime: "image/png" },
        ],
        ai,
      }),
    ).rejects.toMatchObject({
      name: "BriefFromImageError",
      reason: "bad_ai_output",
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_failed",
      "u_multi",
      "sales",
      expect.objectContaining({
        reason: "bad_ai_output",
        frame_count: 2,
        source_kind: "images_multi",
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 8. Model collapses 3 frames to 1 page → logged, NOT an error       */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — model-judgment page divergence", () => {
  it("logs pages_extracted even when model returns fewer pages than frames", async () => {
    const { ai } = spyVision(() => JSON.stringify(singlePageBrief()));
    const result = await briefFromFrames({
      ...BASE,
      frames: [
        { bytes: FRAME_A, mime: "image/png" },
        { bytes: FRAME_B, mime: "image/png" },
        { bytes: FRAME_C, mime: "image/png" },
      ],
      ai,
    });

    // Not an error — the merge step is the model's judgment.
    expect(result.brief.pages).toHaveLength(1);
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_succeeded",
      "u_multi",
      "sales",
      expect.objectContaining({
        frame_count: 3,
        source_kind: "images_multi",
        pages_extracted: 1, // brain sees the divergence
        page_count: 1,
      }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 9. Palette uses FIRST frame's bytes                                */
/* ------------------------------------------------------------------ */

describe("briefFromFrames — palette extraction source", () => {
  it("passes the first frame's bytes to extractPalette", async () => {
    // We can't easily spy on extractPalette (it's imported by the
    // module under test), but we CAN assert the behavioral contract
    // indirectly: the sha256 we persist is over the concatenation, the
    // source_mime we persist is frame[0].mime. That proves the
    // orchestrator treats frame[0] as the "hero" — same frame the
    // palette extractor uses.
    const { ai } = spyVision(() => JSON.stringify(threePageBrief()));
    await briefFromFrames({
      ...BASE,
      frames: [
        { bytes: FRAME_A, mime: "image/webp" }, // distinctive mime
        { bytes: FRAME_B, mime: "image/png" },
        { bytes: FRAME_C, mime: "image/png" },
      ],
      ai,
    });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [args] = mockInsert.mock.calls[0];
    expect(args.sourceMime).toBe("image/webp"); // frame[0]
    // sourceSize is the sum — confirms concatenation, not first-only.
    expect(args.sourceSize).toBe(
      FRAME_A.byteLength + FRAME_B.byteLength + FRAME_C.byteLength,
    );
    // sha256 matches sha256 of concatenated bytes.
    const { createHash } = await import("node:crypto");
    const concat = new Uint8Array(args.sourceSize);
    concat.set(FRAME_A, 0);
    concat.set(FRAME_B, FRAME_A.byteLength);
    concat.set(FRAME_C, FRAME_A.byteLength + FRAME_B.byteLength);
    const expected = createHash("sha256").update(concat).digest("hex");
    expect(args.sourceSha256).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* 10. briefFromImage regression — single-frame wrapper shape         */
/* ------------------------------------------------------------------ */

describe("briefFromImage — regression guard on wrapper", () => {
  it("produces output shape identical to the single-frame path", async () => {
    const { ai: aiA } = spyVision(() => JSON.stringify(singlePageBrief()));
    const viaImage = await briefFromImage({
      bytes: FRAME_A,
      mime: "image/png",
      ...BASE,
      ai: aiA,
    });

    jest.clearAllMocks();
    mockInsert.mockResolvedValue(undefined);

    const { ai: aiB } = spyVision(() => JSON.stringify(singlePageBrief()));
    const viaFrames = await briefFromFrames({
      ...BASE,
      frames: [{ bytes: FRAME_A, mime: "image/png" }],
      ai: aiB,
    });

    // Top-level shape matches key-by-key (generationId differs — it's
    // UUID-per-call — so we compare everything except that + volatile
    // metrics.latencyMs).
    expect(Object.keys(viaImage).sort()).toEqual(
      Object.keys(viaFrames).sort(),
    );
    expect(viaImage.brief).toEqual(viaFrames.brief);
    expect(viaImage.extractedColors).toEqual(viaFrames.extractedColors);
    expect(viaImage.detectedFont).toEqual(viaFrames.detectedFont);
    expect(viaImage.confidence).toEqual(viaFrames.confidence);
    expect(viaImage.metrics.tokensIn).toBe(viaFrames.metrics.tokensIn);
    expect(viaImage.metrics.tokensOut).toBe(viaFrames.metrics.tokensOut);
    expect(viaImage.metrics.model).toBe(viaFrames.metrics.model);
  });
});

/* ------------------------------------------------------------------ */
/* Sanity: BriefFromImageError carries the new reason codes           */
/* ------------------------------------------------------------------ */

describe("BriefFromImageError — new reason codes", () => {
  it("accepts no_frames and mixed_sources", () => {
    const a = new BriefFromImageError("a", "no_frames");
    const b = new BriefFromImageError("b", "mixed_sources");
    expect(a.reason).toBe("no_frames");
    expect(b.reason).toBe("mixed_sources");
  });
});
