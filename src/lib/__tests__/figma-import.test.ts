/**
 * figma-import — unit tests.
 *
 * Every path is exercised with an injected `fetchImpl` so nothing hits
 * the network. Analytics is mocked so we can assert the lib fires the
 * right events per reason.
 */

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import {
  FIGMA_USER_AGENT,
  importFromFigmaUrl,
  nodesToBriefSuggestion,
  paintToHex,
  parseFigmaUrl,
  type FigmaScrapedNode,
} from "@/lib/figma-import";

beforeEach(() => {
  jest.clearAllMocks();
  // The lib reads FIGMA_ACCESS_TOKEN from env; each test sets or clears
  // as needed. Clear the global baseline so tests that expect
  // "not_configured" aren't contaminated by a prior run.
  delete process.env.FIGMA_ACCESS_TOKEN;
});

// Common user for analytics attribution.
const USER = { id: "u_1", role: "sales" };

// Minimal but valid Figma file fixture.
function fixtureFile() {
  return {
    name: "Acme Marketing Site",
    lastModified: "2026-04-19T00:00:00Z",
    document: {
      id: "0:1",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "0:2",
          name: "Page 1",
          type: "CANVAS",
          children: [
            {
              id: "1:1",
              name: "Home — Hero",
              type: "FRAME",
              absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
              children: [
                {
                  id: "2:1",
                  name: "Hero Heading",
                  type: "TEXT",
                  characters: "Welcome to Acme",
                  style: {
                    fontFamily: "Inter",
                    fontPostScriptName: "Inter-Bold",
                    fontWeight: 700,
                    fontSize: 48,
                  },
                  fills: [
                    {
                      type: "SOLID",
                      color: { r: 0.1, g: 0.1, b: 0.1 },
                      opacity: 1,
                    },
                  ],
                },
                {
                  id: "2:2",
                  name: "Hero Subtitle",
                  type: "TEXT",
                  characters: "Fastest widgets around",
                  style: {
                    fontFamily: "Inter",
                    fontPostScriptName: "Inter-Regular",
                    fontWeight: 400,
                    fontSize: 18,
                  },
                },
                {
                  id: "2:3",
                  name: "CTA Block",
                  type: "RECTANGLE",
                  fills: [
                    {
                      type: "SOLID",
                      color: { r: 1, g: 0.533, b: 0 },
                      opacity: 1,
                    },
                  ],
                },
              ],
              fills: [
                {
                  type: "SOLID",
                  color: { r: 0, g: 0.8, b: 0.667 },
                  opacity: 1,
                },
              ],
            },
            {
              id: "1:2",
              name: "Pricing",
              type: "FRAME",
              absoluteBoundingBox: { x: 0, y: 1000, width: 1440, height: 800 },
              children: [
                {
                  id: "3:1",
                  name: "Pricing Header",
                  type: "TEXT",
                  characters: "Plans that scale",
                  style: {
                    fontFamily: "Inter",
                    fontPostScriptName: "Inter-Bold",
                    fontWeight: 700,
                    fontSize: 36,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

// -----------------------------------------------------------------------
// parseFigmaUrl
// -----------------------------------------------------------------------

describe("parseFigmaUrl", () => {
  test("accepts /file/:key URLs", () => {
    const out = parseFigmaUrl("https://www.figma.com/file/ABC123/my-slug");
    expect(out).toEqual({ fileKey: "ABC123" });
  });

  test("accepts /design/:key URLs", () => {
    const out = parseFigmaUrl(
      "https://www.figma.com/design/XyZ987/project-name",
    );
    expect(out).toEqual({ fileKey: "XyZ987" });
  });

  test("accepts bare figma.com without www", () => {
    const out = parseFigmaUrl("https://figma.com/file/ABC123/slug");
    expect(out).toEqual({ fileKey: "ABC123" });
  });

  test("extracts node-id query param when present", () => {
    const out = parseFigmaUrl(
      "https://www.figma.com/file/ABC123/slug?node-id=12-34",
    );
    expect(out).toEqual({ fileKey: "ABC123", nodeId: "12-34" });
  });

  test("rejects non-figma hosts", () => {
    expect(parseFigmaUrl("https://example.com/file/ABC123/slug")).toBeNull();
    expect(
      parseFigmaUrl("https://figma.com.attacker.com/file/ABC123/slug"),
    ).toBeNull();
  });

  test("rejects empty / garbage input", () => {
    expect(parseFigmaUrl("")).toBeNull();
    expect(parseFigmaUrl("not a url")).toBeNull();
    expect(parseFigmaUrl("file:///etc/passwd")).toBeNull();
  });

  test("rejects figma URLs without a file key", () => {
    expect(parseFigmaUrl("https://www.figma.com/")).toBeNull();
    expect(parseFigmaUrl("https://www.figma.com/file/")).toBeNull();
  });

  test("rejects suspicious non-alphanum file keys", () => {
    expect(
      parseFigmaUrl("https://www.figma.com/file/%2fetc%2fpasswd/slug"),
    ).toBeNull();
  });
});

// -----------------------------------------------------------------------
// paintToHex
// -----------------------------------------------------------------------

describe("paintToHex", () => {
  test("converts SOLID rgba 0-1 to hex", () => {
    expect(paintToHex({ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 } }))
      .toBe("#808080");
  });

  test("handles pure black / white extremes", () => {
    expect(paintToHex({ type: "SOLID", color: { r: 0, g: 0, b: 0 } })).toBe(
      "#000000",
    );
    expect(paintToHex({ type: "SOLID", color: { r: 1, g: 1, b: 1 } })).toBe(
      "#ffffff",
    );
  });

  test("returns null for non-SOLID paints", () => {
    expect(
      paintToHex({ type: "GRADIENT_LINEAR", color: { r: 1, g: 0, b: 0 } }),
    ).toBeNull();
    expect(paintToHex(null)).toBeNull();
    expect(paintToHex(undefined)).toBeNull();
  });

  test("returns null for hidden fills", () => {
    expect(
      paintToHex({
        type: "SOLID",
        color: { r: 1, g: 0, b: 0 },
        visible: false,
      } as unknown as Parameters<typeof paintToHex>[0]),
    ).toBeNull();
  });
});

// -----------------------------------------------------------------------
// nodesToBriefSuggestion
// -----------------------------------------------------------------------

describe("nodesToBriefSuggestion", () => {
  test("empty input returns null", () => {
    expect(nodesToBriefSuggestion([])).toBeNull();
  });

  test("produces theme + pages for typical hero+pricing file", () => {
    const frames: FigmaScrapedNode[] = [
      {
        id: "1:1",
        name: "Hero",
        type: "FRAME",
        fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
        children: [
          {
            id: "1:2",
            name: "Heading",
            type: "TEXT",
            characters: "Buy now",
            fontName: { family: "Inter", style: "Bold" },
            fontSize: 48,
          },
        ],
      },
      {
        id: "2:1",
        name: "Pricing",
        type: "FRAME",
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } }],
        children: [
          {
            id: "2:2",
            name: "Tier",
            type: "FRAME",
            children: [
              {
                id: "2:3",
                name: "Price",
                type: "TEXT",
                characters: "$99/mo",
                fontName: { family: "Inter", style: "Regular" },
              },
            ],
          },
        ],
      },
    ];
    const suggestion = nodesToBriefSuggestion(frames);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.theme?.colors?.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(suggestion!.theme?.font?.family).toBe("Inter");
    expect(suggestion!.pages?.length).toBe(2);
    expect(suggestion!.pages![0].route).toBe("/hero");
    expect(suggestion!.pages![1].route).toBe("/pricing");
  });

  test("home-named frames map to root route /", () => {
    const frames: FigmaScrapedNode[] = [
      { id: "1:1", name: "Home", type: "FRAME" },
      { id: "2:1", name: "Landing", type: "FRAME" },
      { id: "3:1", name: "Index", type: "FRAME" },
    ];
    const s = nodesToBriefSuggestion(frames);
    expect(s?.pages?.every((p) => p.route === "/")).toBe(true);
  });

  test("frame names starting with _ or . are skipped", () => {
    const frames: FigmaScrapedNode[] = [
      { id: "1:1", name: "Hero", type: "FRAME" },
      { id: "2:1", name: "_wip draft", type: "FRAME" },
      { id: "3:1", name: ".backup", type: "FRAME" },
    ];
    const s = nodesToBriefSuggestion(frames);
    expect(s?.pages?.length).toBe(1);
  });

  test("frame name heuristics detect hero/pricing/testimonial", () => {
    const frames: FigmaScrapedNode[] = [
      {
        id: "1:1",
        name: "Home",
        type: "FRAME",
        children: [
          { id: "1:2", name: "Hero Banner", type: "FRAME" },
          { id: "1:3", name: "Pricing Table", type: "FRAME" },
          { id: "1:4", name: "Customer Testimonial", type: "FRAME" },
          { id: "1:5", name: "FAQ Section", type: "FRAME" },
        ],
      },
    ];
    const s = nodesToBriefSuggestion(frames);
    const types = (s?.pages?.[0].sections as Array<{ type: string }>).map(
      (x) => x.type,
    );
    expect(types).toContain("hero");
    expect(types).toContain("pricing");
    expect(types).toContain("testimonial");
    expect(types).toContain("faq");
  });

  test("deduplicates fonts across nodes (same family → one entry)", () => {
    const frames: FigmaScrapedNode[] = [
      {
        id: "1:1",
        name: "Home",
        type: "FRAME",
        children: [
          {
            id: "1:2",
            name: "t1",
            type: "TEXT",
            characters: "a",
            fontName: { family: "Roboto", style: "Bold" },
          },
          {
            id: "1:3",
            name: "t2",
            type: "TEXT",
            characters: "b",
            fontName: { family: "Roboto", style: "Regular" },
          },
          {
            id: "1:4",
            name: "t3",
            type: "TEXT",
            characters: "c",
            fontName: { family: "Roboto", style: "Medium" },
          },
        ],
      },
    ];
    const s = nodesToBriefSuggestion(frames);
    expect(s?.theme?.font?.family).toBe("Roboto");
  });

  test("no frames + no colors + no fonts → null", () => {
    const frames: FigmaScrapedNode[] = [
      { id: "1:1", name: "_hidden", type: "FRAME" },
    ];
    // Name starts with `_` so page is skipped, and no fills/fonts
    // exist, so the suggestion is null.
    expect(nodesToBriefSuggestion(frames)).toBeNull();
  });
});

// -----------------------------------------------------------------------
// importFromFigmaUrl — happy + every failure path
// -----------------------------------------------------------------------

describe("importFromFigmaUrl", () => {
  test("invalid URL → invalid_url reason", async () => {
    const res = await importFromFigmaUrl({ url: "not-a-url" }, { user: USER });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid_url");
    expect(mockTrack).toHaveBeenCalledWith(
      "figma_import_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "invalid_url" }),
    );
  });

  test("missing token → not_configured reason", async () => {
    const fetchImpl = jest.fn();
    // Ensure token is not present.
    delete process.env.FIGMA_ACCESS_TOKEN;
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/slug" },
      { user: USER, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "figma_import_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "not_configured" }),
    );
  });

  test("401 from Figma → unauthorized reason", async () => {
    const fetchImpl = jest.fn(
      async () => new Response("nope", { status: 401 }),
    );
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unauthorized");
  });

  test("403 from Figma → unauthorized reason (same class)", async () => {
    const fetchImpl = jest.fn(
      async () => new Response("nope", { status: 403 }),
    );
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.reason).toBe("unauthorized");
  });

  test("404 from Figma → file_not_found reason", async () => {
    const fetchImpl = jest.fn(
      async () => new Response("missing", { status: 404 }),
    );
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/DOESNOTEXIST/slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.reason).toBe("file_not_found");
  });

  test("429 from Figma → rate_limited with Retry-After", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "60" },
        }),
    );
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.reason).toBe("rate_limited");
    expect(res.retryAfterSeconds).toBe(60);
  });

  test("abort → timeout reason", async () => {
    const fetchImpl = jest.fn(async (_url: unknown, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("Aborted");
          (e as unknown as { name: string }).name = "AbortError";
          reject(e);
        });
      });
    });
    const promise = importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    const signal = fetchImpl.mock.calls[0][1].signal as AbortSignal;
    // Provoke the abort. If it lands through the fetch's rejection we
    // get "timeout"; if not, "fetch_failed" is also an acceptable
    // abort outcome (both are structured failures).
    (
      signal as unknown as { dispatchEvent: (e: Event) => void }
    ).dispatchEvent(new Event("abort"));
    const res = await promise;
    expect(["timeout", "fetch_failed"]).toContain(res.reason);
    expect(res.ok).toBe(false);
  });

  test("happy path: full file → populated briefSuggestion + analytics", async () => {
    const fixture = fixtureFile();
    const fetchImpl = jest.fn(async () => jsonResponse(fixture));
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ACME123/my-slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("ok");
    expect(res.scraped?.fileName).toBe("Acme Marketing Site");
    expect(res.scraped?.fileKey).toBe("ACME123");
    expect(res.scraped?.topLevelFrames.length).toBe(2);
    expect(res.scraped?.colors.length).toBeGreaterThan(0);
    expect(res.scraped?.fonts.some((f) => f.family === "Inter")).toBe(true);
    expect(res.scraped?.suggestedBriefPages.length).toBe(2);
    // URL should have been called with X-Figma-Token header.
    const firstCall = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const init = firstCall[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Figma-Token"]).toBe("tok");
    expect(headers["User-Agent"]).toBe(FIGMA_USER_AGENT);
    // Analytics fired.
    expect(mockTrack).toHaveBeenCalledWith(
      "figma_import_completed",
      "u_1",
      "sales",
      expect.objectContaining({
        file_key: "ACME123",
        frame_count: 2,
      }),
    );
  });

  test("analytics metadata never contains the access token", async () => {
    const fixture = fixtureFile();
    const fetchImpl = jest.fn(async () => jsonResponse(fixture));
    await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ACME123/my-slug" },
      {
        user: USER,
        accessToken: "super-secret-token",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    for (const call of mockTrack.mock.calls) {
      const metadata = call[3] as Record<string, unknown>;
      for (const v of Object.values(metadata ?? {})) {
        expect(String(v)).not.toContain("super-secret-token");
      }
    }
  });

  test("empty file (no frames) → empty_result reason", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        name: "Blank",
        lastModified: "2026-04-19T00:00:00Z",
        document: {
          id: "0:1",
          name: "Document",
          type: "DOCUMENT",
          children: [
            // CANVAS with no children — nothing to extract.
            { id: "0:2", name: "Page 1", type: "CANVAS", children: [] },
          ],
        },
      }),
    );
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/blank" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("empty_result");
  });

  test("generic fetch rejection → fetch_failed reason", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("boom"));
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("fetch_failed");
  });

  test("non-JSON response body → fetch_failed reason", async () => {
    const fetchImpl = jest.fn(
      async () =>
        new Response("this is not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res.reason).toBe("fetch_failed");
  });

  test("never throws — every path returns a typed result", async () => {
    // A ludicrous fetch that throws a non-Error is one way upstream code
    // can try to escape typed error handling. Assert the lib catches it.
    const fetchImpl = jest.fn().mockImplementation(() => {
      throw "string-thrown";  
    });
    const res = await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ABC123/slug" },
      {
        user: USER,
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(res).toHaveProperty("ok");
    expect(res).toHaveProperty("reason");
    expect(res).toHaveProperty("scraped");
    expect(res).toHaveProperty("briefSuggestion");
  });

  test("analytics omitted when no user supplied", async () => {
    const fixture = fixtureFile();
    const fetchImpl = jest.fn(async () => jsonResponse(fixture));
    await importFromFigmaUrl(
      { url: "https://www.figma.com/file/ACME123/my-slug" },
      {
        accessToken: "tok",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
