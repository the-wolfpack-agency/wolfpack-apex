/**
 * headlines tool — intent matching, RSS parse happy path, API failure,
 * cache hit. Mocks global fetch so no live network request fires.
 */

const mockTrackEvent = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn(), query: jest.fn() }));

(global as unknown as { fetch: typeof fetch }).fetch =
  mockFetch as unknown as typeof fetch;

import {
  headlinesTool,
  __resetHeadlinesCacheForTests,
} from "@/lib/assistant/tools/headlines";

const match = (q: string) => headlinesTool.matchIntent(q);
const CTX = { userId: "u1", userRole: "cto" };

function rssResp(items: Array<{ title: string; link: string; pubDate?: string }>) {
  const body = items
    .map(
      (i) => `<item>
  <title><![CDATA[${i.title}]]></title>
  <link>${i.link}</link>
  <pubDate>${i.pubDate ?? "Mon, 19 May 2026 10:00:00 GMT"}</pubDate>
</item>`,
    )
    .join("\n");
  const xml = `<?xml version="1.0"?><rss><channel>${body}</channel></rss>`;
  return {
    ok: true,
    text: async () => xml,
  };
}

beforeEach(() => {
  mockTrackEvent.mockReset();
  mockFetch.mockReset();
  __resetHeadlinesCacheForTests();
});

describe("headlines intent matching", () => {
  test.each([
    "headlines",
    "top news",
    "news",
    "top headlines",
    "what's in the news",
    "what's in the news?",
    "news?",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "weather",
    "fx rate",
    "search news about acme",
    "create a news entry",
    "find emails from CNN",
    "what's our revenue this quarter",
  ])("'%s' does NOT match (left to other tools)", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("headlines handler", () => {
  test("happy path: parses RSS + returns widget spec with up to 10 items", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      title: `Headline ${i + 1}`,
      link: `https://bbc.example/${i + 1}`,
    }));
    mockFetch.mockResolvedValue(rssResp(items));

    const r = await headlinesTool.handler({}, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget?.kind).toBe("headlines");
    const spec = r.widget as {
      kind: "headlines";
      items: Array<{ title: string; link: string; source: string }>;
    };
    expect(spec.items).toHaveLength(10);
    expect(spec.items[0].title).toBe("Headline 1");
    expect(spec.items[0].source).toBe("BBC News");
    expect(r.answer).toMatch(/Top 10 headlines/i);
  });

  test("CDATA + HTML entities are decoded in titles", async () => {
    const items = [{ title: "Smith &amp; Jones win", link: "https://x.example/1" }];
    mockFetch.mockResolvedValue(rssResp(items));
    const r = await headlinesTool.handler({}, CTX);
    if (!r.ok) return;
    const spec = r.widget as { items: Array<{ title: string }> };
    expect(spec.items[0].title).toBe("Smith & Jones win");
  });

  test("API failure → returns internal error", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    const r = await headlinesTool.handler({}, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/external_api_failed/);
  });

  test("network error → returns internal error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await headlinesTool.handler({}, CTX);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    /* This asserted the provider's raw text ("ECONNREFUSED") reached the
       message. The shared feed reader catches the throw and reports null, so
       that detail is no longer carried: a deliberate trade of one line of
       diagnostic text for one parser instead of two. What must NOT be lost is
       that this is reported as a failure at all, and which feed failed, so
       that is what is asserted now. The analytics reason is unchanged. */
    expect(r.message).toMatch(/external_api_failed/);
    expect(r.message).toMatch(/BBC News/);
  });

  test("cache hit: second call skips network", async () => {
    mockFetch.mockResolvedValue(
      rssResp([{ title: "Cached", link: "https://bbc.example/c" }]),
    );
    const r1 = await headlinesTool.handler({}, CTX);
    expect(r1.ok).toBe(true);
    const afterFirst = mockFetch.mock.calls.length;
    const r2 = await headlinesTool.handler({}, CTX);
    expect(r2.ok).toBe(true);
    expect(mockFetch.mock.calls.length).toBe(afterFirst);

    const cacheHitEvents = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "assistant.headlines_executed" && c[3]?.cache_hit === true,
    );
    expect(cacheHitEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("fires assistant.headlines_executed on happy path", async () => {
    mockFetch.mockResolvedValue(
      rssResp([{ title: "x", link: "https://x.example/1" }]),
    );
    await headlinesTool.handler({}, CTX);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.headlines_executed",
      "u1",
      "cto",
      expect.objectContaining({ success: true }),
    );
  });
});
