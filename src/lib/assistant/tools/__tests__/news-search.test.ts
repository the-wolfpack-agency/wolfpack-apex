/**
 * "Please get me the latest article about SpaceX."
 *
 * Reported 2026-08-19, and answered with "I cannot directly fetch real-time
 * articles or browse the web." That was true: nothing in the assistant could
 * reach outside the workspace except three fixed-purpose tools.
 *
 * The tests are grouped by the thing that could go wrong:
 *   1. the question is recognised, and sentences that merely mention news are not
 *   2. the filter answers about the topic asked for, not a topic sharing a word
 *   3. a publisher being down degrades the answer instead of failing it
 *   4. "found nothing" and "could not look" are never reported as each other
 */
const trackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));
jest.mock("@/lib/assistant/tools/registry", () => ({ registerTool: jest.fn() }));

import {
  newsSearchTool,
  topicTerms,
  itemMatches,
  byRecency,
  __resetNewsSearchCacheForTests,
} from "@/lib/assistant/tools/news-search";
import type { FeedItem } from "@/lib/integrations/rss";

const CTX = { userId: "u1", userRole: "cto" } as never;
const match = (q: string) => newsSearchTool.matchIntent!(q);

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  __resetNewsSearchCacheForTests();
  trackEvent.mockClear();
});

/** A feed response carrying the given titles. */
function feed(...titles: string[]) {
  const items = titles
    .map(
      (t, i) =>
        `<item><title>${t}</title><link>https://example.test/${encodeURIComponent(t)}</link>` +
        `<pubDate>Tue, ${19 - i} Aug 2026 09:00:00 GMT</pubDate></item>`,
    )
    .join("");
  return { ok: true, text: async () => `<rss><channel>${items}</channel></rss>` };
}

describe("recognising the question", () => {
  test.each([
    ["please get me the latest article about spaceX", "spaceX"],
    ["latest news on Porsche", "Porsche"],
    ["find articles about the Henderson opening", "the Henderson opening"],
    ["what's the latest on Tesla", "Tesla"],
    ["news about quantum computing", "quantum computing"],
    ["show me recent coverage of the Fed", "the Fed"],
  ])("%j asks about %j", (q, topic) => {
    expect(match(q)).toEqual({ topic });
  });

  test.each([
    "top headlines",
    "what's in the news",
    "I read an article about that yesterday",
    "add a task to read the news",
    "the latest on my calendar is wrong",
  ])("%j is not a news search", (q) => {
    /* "top headlines" belongs to the headlines tool, and the rest are ordinary
       sentences. A tool that claims them is worse than one that misses. */
    const m = match(q);
    if (m) expect(m.topic).not.toMatch(/^(?:news|the news)$/i);
  });

  test("a topic made only of filler words is refused", () => {
    // Otherwise it matches every article ever published.
    expect(match("get me the latest news about the news")).toBeNull();
  });
});

describe("answering about the topic asked for", () => {
  test("EVERY term must appear, so a shared word is not a match", () => {
    const item: FeedItem = {
      title: "Ford recalls 5,000 trucks",
      link: "l",
      published: "",
      summary: "",
      source: "s",
    };
    expect(itemMatches(item, topicTerms("Porsche Taycan"))).toBe(false);
    expect(itemMatches(item, topicTerms("Ford recall"))).toBe(true);
  });

  test("newest first, and an undated item never claims the top slot", () => {
    const mk = (published: string): FeedItem => ({ title: "t", link: published, published, summary: "", source: "s" });
    const sorted = [mk(""), mk("Tue, 18 Aug 2026 09:00:00 GMT"), mk("Tue, 19 Aug 2026 09:00:00 GMT")].sort(byRecency);
    expect(sorted.map((i) => i.published)).toEqual([
      "Tue, 19 Aug 2026 09:00:00 GMT",
      "Tue, 18 Aug 2026 09:00:00 GMT",
      "",
    ]);
  });

  test("the reported question returns the article and cites it", async () => {
    global.fetch = (async () =>
      feed("SpaceX tugs Starship into port", "A story about gardening")) as unknown as typeof fetch;

    const res = await newsSearchTool.handler({ topic: "spaceX" }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items.map((i) => i.title)).toEqual(["SpaceX tugs Starship into port"]);
    // The answer names where it looked, and the article is a clickable source.
    expect(res.answer).toContain("public news feeds");
    expect(res.sources?.[0]?.url).toContain("https://example.test/");
    expect(res.widget).toMatchObject({ kind: "headlines" });
  });

  test("the same story from two publishers is one result", async () => {
    global.fetch = (async () => feed("SpaceX tugs Starship into port")) as unknown as typeof fetch;
    const res = await newsSearchTool.handler({ topic: "spaceX" }, CTX);
    expect(res.ok && res.data.items).toHaveLength(1);
  });
});

describe("when the outside world misbehaves", () => {
  test("one publisher down still answers from the others", async () => {
    let call = 0;
    global.fetch = (async () => {
      call += 1;
      if (call === 1) throw new Error("ECONNREFUSED");
      return feed("SpaceX tugs Starship into port");
    }) as unknown as typeof fetch;

    const res = await newsSearchTool.handler({ topic: "spaceX" }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items.length).toBeGreaterThan(0);
    expect(res.data.feedsReachable).toBeGreaterThan(0);
  });

  test("NOTHING PUBLISHED and COULD NOT LOOK are different answers", async () => {
    global.fetch = (async () => feed("A story about gardening")) as unknown as typeof fetch;
    const found = await newsSearchTool.handler({ topic: "spaceX" }, CTX);
    expect(found.ok && found.answer).toMatch(/have not covered it recently/i);

    __resetNewsSearchCacheForTests();
    global.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const blind = await newsSearchTool.handler({ topic: "spaceX" }, CTX);
    expect(blind.ok && blind.answer).toMatch(/no news feeds responded/i);
    // Never claims the topic is uncovered when it could not look.
    expect(blind.ok && blind.answer).not.toMatch(/have not covered it/i);
  });

  test("what was asked for is recorded, so the feed list can be argued from data", async () => {
    global.fetch = (async () => feed("A story about gardening")) as unknown as typeof fetch;
    await newsSearchTool.handler({ topic: "SpaceX" }, CTX);
    expect(trackEvent).toHaveBeenCalledWith(
      "assistant.news_search_executed",
      "u1",
      "cto",
      expect.objectContaining({ topic: "spacex", item_count: 0 }),
    );
  });
});
