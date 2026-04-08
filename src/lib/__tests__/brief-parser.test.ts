/**
 * Brief parser tests — heuristic + AI fallback + analytics contract.
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  stripHtml,
  heuristicParse,
  aiParse,
  parseBrief,
  type AICaller,
} from "@/lib/brief-parser";

const RICH_HTML = `
<html><body>
  <h1>Cleared for Takeoff Racing</h1>
  <h2>Aidan Mulready — Sponsor Acquisition</h2>
  <p>An Irish racing driver who claimed a championship in his first ever year. Year two: Nürburgring with Breakell Racing.</p>
  <div>145M+ Digital Views</div>
  <div>280K Fans On-Site</div>
  <div>93M+ Short-Form Views</div>
  <div>60+ Cameras On Broadcast</div>
  <img src="/img/IMG_4185.jpg" alt="BMW rear" />
  <img src="/img/IMG_4184.jpg" alt="Pitlane" />
  <img src="/img/IMG_4190.jpg" alt="Helmet" />
</body></html>
`;

describe("stripHtml", () => {
  it("strips tags, scripts, styles, entities", () => {
    const out = stripHtml('<div>Hello <script>alert(1)</script> &amp; <style>.x{}</style> world</div>');
    expect(out).toBe("Hello & world");
  });
});

describe("heuristicParse", () => {
  beforeEach(() => jest.clearAllMocks());

  it("extracts hero, text, stats, gallery from a rich design brief", () => {
    const { brief, confidence } = heuristicParse(RICH_HTML, "cftr");
    expect(confidence).toBe("high");
    expect(brief.client).toBe("cftr");
    expect(brief.product.name).toBe("Cleared for Takeoff Racing");
    const types = brief.pages[0].sections.map((s) => s.type);
    expect(types).toContain("hero");
    expect(types).toContain("stats");
    expect(types).toContain("gallery");
  });

  it("stats values are real numbers (not strings)", () => {
    const { brief } = heuristicParse(RICH_HTML, "cftr");
    const stats = brief.pages[0].sections.find((s) => s.type === "stats");
    expect(stats).toBeDefined();
    for (const it of stats!.items ?? []) {
      expect(typeof it.value).toBe("number");
    }
  });

  it("gallery contains image references", () => {
    const { brief } = heuristicParse(RICH_HTML, "cftr");
    const gal = brief.pages[0].sections.find((s) => s.type === "gallery");
    expect(gal!.images?.length).toBeGreaterThanOrEqual(2);
  });

  it("returns low confidence on empty/garbage input", () => {
    const { confidence } = heuristicParse("just some words", "x");
    expect(confidence).toBe("low");
  });

  it("skips embedded base64 data: URIs in v1", () => {
    const html = '<img src="data:image/png;base64,abc"/><img src="/real.jpg"/>';
    const { brief } = heuristicParse(html, "x");
    const gal = brief.pages[0].sections.find((s) => s.type === "gallery");
    if (gal) {
      const srcs = (gal.images ?? []).map((i) => (typeof i === "string" ? i : i.src));
      for (const s of srcs) expect(s.startsWith("data:")).toBe(false);
    }
  });
});

describe("aiParse", () => {
  it("returns null when AI caller returns null", async () => {
    const ai: AICaller = async () => null;
    const out = await aiParse("anything", "test", ai);
    expect(out).toBeNull();
  });

  it("strips ```json fences and validates", async () => {
    const ai: AICaller = async () => ({
      content: '```json\n{"client":"test","product":{"name":"X"},"pages":[{"route":"/","sections":[{"type":"text","body":"hi"}]}]}\n```',
      tokensUsed: 42,
    });
    const out = await aiParse("doc", "test", ai);
    expect(out).not.toBeNull();
    expect(out!.brief.product.name).toBe("X");
    expect(out!.tokensUsed).toBe(42);
  });

  it("forces the supplied client slug even if AI returned a different one", async () => {
    const ai: AICaller = async () => ({
      content: '{"client":"wrong-slug","product":{"name":"X"},"pages":[{"route":"/","sections":[{"type":"text","body":"hi"}]}]}',
      tokensUsed: 10,
    });
    const out = await aiParse("doc", "right-slug", ai);
    expect(out!.brief.client).toBe("right-slug");
  });

  it("returns null when AI output is invalid JSON", async () => {
    const ai: AICaller = async () => ({ content: "not json", tokensUsed: 5 });
    const out = await aiParse("doc", "test", ai);
    expect(out).toBeNull();
  });

  it("returns null when AI output fails brief validation", async () => {
    const ai: AICaller = async () => ({
      content: '{"client":"test","product":{"name":"X"},"pages":[{"route":"/","sections":[{"type":"frob"}]}]}',
      tokensUsed: 5,
    });
    expect(await aiParse("doc", "test", ai)).toBeNull();
  });
});

describe("parseBrief — full pipeline", () => {
  beforeEach(() => jest.clearAllMocks());

  it("uses heuristic when confidence is high (zero tokens)", async () => {
    const aiCalled = jest.fn();
    const ai: AICaller = async (...args) => {
      aiCalled(...args);
      return null;
    };
    const result = await parseBrief(RICH_HTML, "cftr", "u", "sales", ai);
    expect(result.source).toBe("heuristic");
    expect(result.tokensUsed).toBe(0);
    expect(aiCalled).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_auto_parsed",
      "u",
      "sales",
      expect.objectContaining({ source: "heuristic", tokens_used: 0 }),
    );
  });

  it("falls through to AI when heuristic is low confidence", async () => {
    const ai: AICaller = async () => ({
      content: '{"client":"test","product":{"name":"X"},"pages":[{"route":"/","sections":[{"type":"hero","heading":"X","body":"Y"}]}]}',
      tokensUsed: 123,
    });
    const result = await parseBrief("just a sentence", "test", "u", "sales", ai);
    expect(result.source).toBe("ai");
    expect(result.tokensUsed).toBe(123);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "site.brief_auto_parsed",
      "u",
      "sales",
      expect.objectContaining({ source: "ai", tokens_used: 123 }),
    );
  });

  it("falls back to medium-confidence heuristic when AI fails", async () => {
    const ai: AICaller = async () => null;
    const result = await parseBrief("Some Title. With a paragraph that has enough characters to count as substance for a brief output.", "test", "u", "sales", ai);
    expect(result.source).toBe("heuristic");
    const events = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain("site.brief_auto_parsed");
  });

  it("emits site.brief_parse_failed when nothing produces a valid brief", async () => {
    const ai: AICaller = async () => null;
    // Force heuristic to produce something invalid by passing an empty string
    // (the heuristic still tries; we expect parse_failed only if validation throws)
    // Use a clientSlug that fails the slug regex to force validation failure.
    await expect(parseBrief("x", "BAD_SLUG", "u", "sales", ai)).rejects.toThrow();
    const events = mockTrackEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain("site.brief_parse_failed");
  });
});
