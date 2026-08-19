/**
 * news_search — "what is the latest on X", answered from the actual web.
 *
 * WHY THIS EXISTS
 *
 * Reported 2026-08-19: "please get me the latest article about spaceX" came
 * back with "I cannot directly fetch real-time articles or browse the web."
 * That was true and it should not have been: nothing in the assistant could
 * reach outside the workspace except three fixed-purpose tools (weather, fx,
 * one BBC feed), so the question fell through to the model, which answered from
 * training and correctly said it could not browse.
 *
 * NO NEW DEPENDENCY, which was the explicit instruction. Not an npm package,
 * and not a third-party search API either: a search key is a contract, a bill,
 * a rate limit and an outage to own. This reads public RSS feeds the same way
 * `headlines` already reads the BBC, filters them locally, and adds nothing to
 * the runtime.
 *
 * WHAT IT IS, HONESTLY. It searches recent items across a curated set of
 * reputable feeds. It is NOT a web crawler and does not pretend to be: it
 * cannot find a story no covered publisher wrote, and it does not open the
 * article to read it. The answer always names how many feeds were searched so
 * a reader can tell "nothing published" from "we did not look there".
 *
 * WHY NOT GOOGLE NEWS RSS, which would search everything: its feed states it is
 * "made available solely for the purpose of rendering Google News results
 * within a personal feed reader for personal, non-commercial use. Any other use
 * of the feed is expressly prohibited." This is a commercial product. Publisher
 * feeds are published for syndication, which is exactly this. (It also returned
 * zero items for the reported query when tried.)
 *
 * NO SSRF SURFACE. The feed list is a frozen constant in this file. A user's
 * words become a filter applied to what came back, never a URL that gets
 * fetched.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";
import { fetchFeed, type FeedItem } from "@/lib/integrations/rss";

/**
 * The feeds searched. Deliberately small and general-interest: enough to cover
 * business, technology, science and world news, few enough that a search is
 * four parallel requests rather than forty.
 *
 * Adding one is a single line here. Each is a publisher's own syndication feed,
 * which is what RSS is for.
 */
const FEEDS: readonly { url: string; source: string }[] = Object.freeze([
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC News" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC Business" },
  { url: "https://feeds.bbci.co.uk/news/technology/rss.xml", source: "BBC Technology" },
  { url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", source: "BBC Science" },
  { url: "https://feeds.arstechnica.com/arstechnica/index", source: "Ars Technica" },
  { url: "https://www.nasa.gov/news-release/feed/", source: "NASA" },
]);

const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 8;
const PER_FEED_LIMIT = 40;

/**
 * How somebody asks for this. Anchored, like every other tool intent, so a
 * sentence that happens to contain "news" does not trigger a search.
 *
 * The capture is the SUBJECT, and the trailing-words group exists because
 * "the latest article about SpaceX today" is one question, not two.
 */
const INTENT_RE =
  /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:get|find|fetch|show|give)?\s*(?:me\s+)?(?:the\s+)?(?:latest|recent|newest|current|any)?\s*(?:news|articles?|stories|headlines|coverage|updates?)\s+(?:about|on|of|for|regarding|re)\s+(.+?)\s*\??\s*$/i;

/** The other phrasing: "what's the latest on X". */
const INTENT_RE_LATEST_ON =
  /^\s*(?:what(?:'?s| is| are)\s+)?(?:the\s+)?(?:latest|newest|news)\s+(?:on|about|with|for)\s+(.+?)\s*\??\s*$/i;

/** Words that carry no meaning as a filter, so they never narrow a search. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "for", "and", "or", "to", "about",
  "latest", "news", "article", "articles", "story", "stories", "today",
  "please", "me", "get", "any", "recent",
]);

const ParamSchema = z.object({
  /** What the reader asked about, as they wrote it. */
  topic: z.string().min(2).max(120),
});
type Params = z.infer<typeof ParamSchema>;

export interface NewsSearchToolData {
  topic: string;
  items: FeedItem[];
  /** How many feeds answered, so "no results" is distinguishable from "no
   *  feeds reachable" by whoever reads the answer. */
  feedsSearched: number;
  feedsReachable: number;
}

const cache = new Map<string, { expires: number; data: NewsSearchToolData }>();

/** Test seam: the cache would otherwise carry fixtures between tests. */
export function __resetNewsSearchCacheForTests(): void {
  cache.clear();
}

/** The words a result has to contain to count as being about the topic. */
export function topicTerms(topic: string): string[] {
  return topic
    .toLowerCase()
    .split(/[^a-z0-9+]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Does this item match?
 *
 * EVERY term must appear, in the title or the summary. "Any term" would answer
 * "latest on Porsche Taycan" with an article about a Ford. When the reader gave
 * only one meaningful word, that word alone is the whole test, which is the
 * behaviour they expect from a search box.
 */
export function itemMatches(item: FeedItem, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** Newest first. Items with no parseable date sort last rather than first: an
 *  undated item claiming the top slot would read as the freshest thing there. */
export function byRecency(a: FeedItem, b: FeedItem): number {
  const ta = Date.parse(a.published);
  const tb = Date.parse(b.published);
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return tb - ta;
}

export const newsSearchTool: ToolDef<Params, NewsSearchToolData> = {
  name: "news_search",
  description:
    "Recent published articles about a topic, searched across public news feeds. No API key, no third-party search service.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent(message: string): Params | null {
    const m = INTENT_RE.exec(message) ?? INTENT_RE_LATEST_ON.exec(message);
    const topic = m?.[1]?.trim();
    if (!topic) return null;
    /* A topic that is nothing but stopwords ("the latest news on the news")
       would match every article ever published. */
    return topicTerms(topic).length > 0 ? { topic } : null;
  },
  async handler(params, ctx): Promise<ToolResult<NewsSearchToolData>> {
    const key = params.topic.trim().toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
      trackEvent("assistant.news_search_executed", ctx.userId, ctx.userRole, {
        topic: key,
        item_count: cached.data.items.length,
        success: true,
        cache_hit: true,
      });
      return buildSuccess(cached.data);
    }

    /* Every feed at once. One slow publisher costs the slowest feed's time,
       not the sum of all of them, and fetchFeed never throws so a feed that is
       down simply contributes nothing. */
    const perFeed = await Promise.all(
      FEEDS.map((f) => fetchFeed(f.url, f.source, FETCH_TIMEOUT_MS, PER_FEED_LIMIT)),
    );
    /* Reachability is now reported by the reader rather than guessed from
       whether a feed happened to contain a match, which is what makes
       "nothing published" and "could not look" tellable apart below. */
    const feedsReachable = perFeed.filter((items) => items !== null).length;

    const terms = topicTerms(params.topic);
    const seen = new Set<string>();
    const items = perFeed
      .filter((items): items is FeedItem[] => items !== null)
      .flat()
      .filter((item) => itemMatches(item, terms))
      /* Two publishers running the same wire story is one story to a reader. */
      .filter((item) => {
        const k = item.link.split("?")[0];
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort(byRecency)
      .slice(0, MAX_RESULTS);

    const data: NewsSearchToolData = {
      topic: params.topic,
      items,
      feedsSearched: FEEDS.length,
      feedsReachable,
    };
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });

    trackEvent("assistant.news_search_executed", ctx.userId, ctx.userRole, {
      topic: key,
      item_count: items.length,
      feeds_reachable: feedsReachable,
      success: true,
      cache_hit: false,
    });

    return buildSuccess(data);
  },
};

export function buildSuccess(data: NewsSearchToolData): ToolResult<NewsSearchToolData> {
  const widget: WidgetSpec = {
    kind: "headlines",
    title: `Latest on ${data.topic}`,
    subtitle: `${data.items.length} article${data.items.length === 1 ? "" : "s"} across ${data.feedsSearched} news feeds`,
    items: data.items,
  };

  /* THE ANSWER SAYS WHERE IT LOOKED. "Nothing found" and "nothing published"
     are different facts, and a reader who cannot tell them apart learns to
     distrust both. */
  const answer =
    data.items.length > 0
      ? `${data.items.length} recent article${data.items.length === 1 ? "" : "s"} about ${data.topic}, newest first, from ${data.feedsSearched} public news feeds.`
      : data.feedsReachable === 0
        ? `No news feeds responded just now, so I could not check for articles about ${data.topic}. Worth trying again in a moment.`
        : `Nothing about ${data.topic} in the last few days across the ${data.feedsSearched} news feeds I read. That means those publishers have not covered it recently, not that nothing was published anywhere.`;

  const sources = data.items.map((i) => ({
    id: i.link,
    title: i.title,
    url: i.link,
    type: "web" as const,
  }));

  return { ok: true, data, answer, widget, sources };
}

registerTool(newsSearchTool as unknown as ToolDef<Record<string, unknown>, unknown>);
