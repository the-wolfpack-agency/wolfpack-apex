/**
 * brief-from-image unit tests.
 *
 * Covers:
 *  - happy path: valid vision JSON → brief, theme merged, palette returned
 *  - bad MIME → BriefFromImageError(unsupported_mime) + analytics
 *  - malformed JSON → BriefFromImageError(bad_ai_output) + analytics
 *  - validateBrief failure → BriefFromImageError(brief_invalid)
 *  - AI returns null → BriefFromImageAIUnavailableError + analytics
 *  - NotConfigured thrown from caller → surfaces distinct error + analytics
 *  - insertBriefGeneration is called with canonical shape
 *  - mergePaletteIntoBrief prefers measured palette over model hints
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
  mergePaletteIntoBrief,
  BriefFromImageError,
  BriefFromImageAIUnavailableError,
  BriefFromImageNotConfiguredError,
  type VisionCaller,
} from "@/lib/brief-from-image";
import type { SiteBrief, SiteTheme } from "@/lib/sites-schema";

const PNG_1x1_RED = Buffer.from(
  // Minimal valid PNG our decoder won't fully parse (zero CRC) but
  // the extractPalette fallback will return an empty palette for.
  // For tests we don't care about the palette fidelity — the model
  // mock drives the brief. The orchestrator still calls extractPalette.
  "89504e470d0a1a0a" + // signature
    "0000000d49484452" + // IHDR len + type
    "0000000100000001" + // 1x1
    "08020000000000" + // depth 8, color 2 (RGB), rest zero
    "00000000" + // fake CRC
    "0000000c49444154" + // IDAT len=12 (arbitrary — decoder checks crc-less)
    "789c63f8cfc0f00f00030001" + // deflate stream (not exact)
    "00000000" + // fake CRC
    "0000000049454e44ae426082",
  "hex",
);

function goodVisionResponse(overrides: Partial<SiteBrief> = {}): string {
  const brief: SiteBrief = {
    client: "TO_BE_OVERWRITTEN",
    product: { name: "Cleared For Takeoff Racing", tagline: "Irish racing" },
    theme: {
      colors: { primary: "#000000", accent: "#ff00ff" },
    },
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
          {
            type: "stats",
            heading: "By the numbers",
            items: [
              { label: "Digital Views", value: 145, suffix: "M+" },
              { label: "Fans On-Site", value: 280, suffix: "K" },
              { label: "Short-Form Views", value: 93, suffix: "M+" },
            ],
          },
        ],
      },
    ],
    contactForm: { fields: ["name", "email"] },
    ...overrides,
  };
  return JSON.stringify(brief);
}

function stubVision(
  content: string,
  tokensIn = 400,
  tokensOut = 300,
): VisionCaller {
  return async () => ({
    content,
    tokensIn,
    tokensOut,
    model: "claude-haiku-4-5-20251001",
  });
}

const BASE_INPUT = {
  bytes: new Uint8Array(PNG_1x1_RED),
  mime: "image/png",
  clientSlug: "cftr",
  userId: "u_1",
  userRole: "sales",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockInsert.mockResolvedValue(undefined);
});

describe("briefFromImage — happy path", () => {
  it("returns a valid brief + metrics + palette + generationId", async () => {
    const ai = stubVision(goodVisionResponse());
    const result = await briefFromImage({ ...BASE_INPUT, ai });

    expect(result.generationId).toMatch(/^site_brief_gen_/);
    expect(result.brief.client).toBe("cftr"); // forced-slug wins
    expect(result.brief.product.name).toBe("Cleared For Takeoff Racing");
    expect(result.brief.pages).toHaveLength(1);
    expect(result.brief.pages[0].sections.length).toBeGreaterThanOrEqual(2);
    expect(result.metrics.tokensIn).toBe(400);
    expect(result.metrics.tokensOut).toBe(300);
    expect(result.metrics.model).toBe("claude-haiku-4-5-20251001");
    expect(result.metrics.costCents).toBeGreaterThanOrEqual(0);
    expect(result.metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toMatch(/low|medium|high/);
  });

  it("fires site.brief_generation_requested + succeeded analytics", async () => {
    const ai = stubVision(goodVisionResponse());
    await briefFromImage({ ...BASE_INPUT, ai });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_requested",
      "u_1",
      "sales",
      expect.objectContaining({
        generation_id: expect.stringMatching(/^site_brief_gen_/),
        mime: "image/png",
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_succeeded",
      "u_1",
      "sales",
      expect.objectContaining({
        model: "claude-haiku-4-5-20251001",
        tokens_in: 400,
        tokens_out: 300,
      }),
    );
  });

  it("persists a generation row via insertBriefGeneration", async () => {
    const ai = stubVision(goodVisionResponse());
    const result = await briefFromImage({ ...BASE_INPUT, ai });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [args] = mockInsert.mock.calls[0];
    expect(args.id).toBe(result.generationId);
    expect(args.requestedBy).toBe("u_1");
    expect(args.sourceMime).toBe("image/png");
    expect(args.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(args.extractedBrief.client).toBe("cftr");
    expect(args.model).toBe("claude-haiku-4-5-20251001");
  });

  it("strips markdown fences from vision output", async () => {
    const ai = stubVision("```json\n" + goodVisionResponse() + "\n```");
    const result = await briefFromImage({ ...BASE_INPUT, ai });
    expect(result.brief.pages).toHaveLength(1);
  });
});

describe("briefFromImage — error paths", () => {
  it("rejects unsupported MIME with site.brief_image_rejected", async () => {
    const ai = stubVision(goodVisionResponse());
    await expect(
      briefFromImage({ ...BASE_INPUT, mime: "application/zip", ai }),
    ).rejects.toMatchObject({
      name: "BriefFromImageError",
      reason: "unsupported_mime",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_image_rejected",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "unsupported_mime" }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("throws BriefFromImageAIUnavailableError when AI returns null", async () => {
    const ai: VisionCaller = async () => null;
    await expect(
      briefFromImage({ ...BASE_INPUT, ai }),
    ).rejects.toBeInstanceOf(BriefFromImageAIUnavailableError);
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "ai_unavailable" }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("surfaces BriefFromImageNotConfiguredError when caller throws it", async () => {
    const ai: VisionCaller = async () => {
      throw new BriefFromImageNotConfiguredError();
    };
    await expect(
      briefFromImage({ ...BASE_INPUT, ai }),
    ).rejects.toBeInstanceOf(BriefFromImageNotConfiguredError);
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "ai_not_configured" }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("throws BriefFromImageError(bad_ai_output) on malformed JSON", async () => {
    const ai = stubVision("this is not JSON at all");
    await expect(
      briefFromImage({ ...BASE_INPUT, ai }),
    ).rejects.toMatchObject({
      name: "BriefFromImageError",
      reason: "bad_ai_output",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "bad_ai_output" }),
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("throws BriefFromImageError(brief_invalid) on schema-invalid output", async () => {
    // pages missing → validateBrief throws
    const bad = JSON.stringify({
      client: "whatever",
      product: { name: "X" },
      pages: [],
    });
    const ai = stubVision(bad);
    await expect(
      briefFromImage({ ...BASE_INPUT, ai }),
    ).rejects.toMatchObject({
      name: "BriefFromImageError",
      reason: "brief_invalid",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "site.brief_generation_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "brief_invalid" }),
    );
  });

  it("rejects non-object JSON (e.g. a number) as bad_ai_output", async () => {
    const ai = stubVision("42");
    await expect(
      briefFromImage({ ...BASE_INPUT, ai }),
    ).rejects.toMatchObject({
      name: "BriefFromImageError",
      reason: "bad_ai_output",
    });
  });
});

describe("mergePaletteIntoBrief", () => {
  const BRIEF: SiteBrief = {
    client: "cftr",
    product: { name: "X" },
    theme: { colors: { primary: "#000000", accent: "#00ff00" } },
    pages: [{ route: "/", sections: [{ type: "hero", heading: "H" }] }],
  };

  it("returns brief unchanged when palette is empty", () => {
    const out = mergePaletteIntoBrief(BRIEF, { swatches: [], weights: [] });
    expect(out).toEqual(BRIEF);
  });

  it("overrides model hints with measured palette when present", () => {
    const out = mergePaletteIntoBrief(BRIEF, {
      swatches: ["#123456", "#abcdef", "#000000", "#ffffff", "#888888"],
      weights: [0.4, 0.3, 0.15, 0.1, 0.05],
    });
    const theme = out.theme as SiteTheme;
    expect(theme.colors?.primary).toBe("#123456");
    expect(theme.colors?.accent).toBe("#abcdef");
    expect(theme.colors?.bg).toBe("#000000");
    expect(theme.colors?.fg).toBe("#ffffff");
  });

  it("preserves font hint from the model", () => {
    const withFont: SiteBrief = {
      ...BRIEF,
      theme: {
        colors: {},
        font: { family: "Inter" },
      },
    };
    const out = mergePaletteIntoBrief(withFont, {
      swatches: ["#111111", "#222222", "#333333"],
      weights: [0.5, 0.3, 0.2],
    });
    const theme = out.theme as SiteTheme;
    expect(theme.font?.family).toBe("Inter");
  });
});
