/**
 * headlines — empty-state demo tool that surfaces the top 10 world-news
 * stories so a brand-new user with zero integrations connected has
 * something to ask within the first 30 seconds.
 *
 * Backed by the BBC World RSS feed (http://feeds.bbci.co.uk/news/world/rss.xml).
 * No API key required, free, stable, and CORS-irrelevant because the
 * fetch is server-side from the tool handler.
 *
 * NewsAPI was deliberately rejected here — its free tier blocks
 * non-localhost requests, which would break the moment we deploy.
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";

const RSS_URL = "http://feeds.bbci.co.uk/news/world/rss.xml";
const SOURCE_NAME = "BBC News";
const MAX_ITEMS = 10;
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const INTENT_RE =
  /^\s*(?:top\s+)?(?:news|headlines|what'?s\s+in\s+the\s+news)\??\s*$/i;

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

export interface HeadlineItem {
  title: string;
  link: string;
  published: string;
  source: string;
}

export interface HeadlinesToolData {
  items: HeadlineItem[];
}

interface CacheEntry {
  expires: number;
  data: HeadlinesToolData;
}
const cache = new Map<string, CacheEntry>();
const CACHE_KEY = "bbc-world";

/** Test seam — wipe the in-memory cache between tests so per-test
 *  fetch-call assertions aren't poisoned by prior fixtures. */
export function __resetHeadlinesCacheForTests(): void {
  cache.clear();
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* Minimal RSS parser — pulls every <item>…</item> block, then extracts
 * <title>, <link>, <pubDate> from each. We deliberately don't import a
 * full XML library: the BBC feed shape is stable, the regex is
 * defensive against CDATA wrappers, and a third-party dep would
 * violate "no new runtime dependencies" from CLAUDE.md. */
function parseRss(xml: string): HeadlineItem[] {
  const items: HeadlineItem[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pub = extractTag(block, "pubDate");
    if (!title || !link) continue;
    items.push({
      title,
      link,
      published: pub,
      source: SOURCE_NAME,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return "";
  let raw = m[1].trim();
  /* Unwrap <![CDATA[ … ]]>. */
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  if (cdata) raw = cdata[1].trim();
  /* Decode the handful of HTML entities the BBC feed uses. */
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export const headlinesTool: ToolDef<Params, HeadlinesToolData> = {
  name: "headlines",
  description:
    "Top world-news headlines from a free public RSS feed. Empty-state demo tool — no integration required.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent(message: string): Params | null {
    return INTENT_RE.test(message) ? {} : null;
  },
  async handler(_params, ctx): Promise<ToolResult<HeadlinesToolData>> {
    const cached = cache.get(CACHE_KEY);
    if (cached && cached.expires > Date.now()) {
      trackEvent("assistant.headlines_executed", ctx.userId, ctx.userRole, {
        item_count: cached.data.items.length,
        success: true,
        cache_hit: true,
      });
      return buildSuccess(cached.data);
    }

    try {
      const res = await fetchWithTimeout(RSS_URL, FETCH_TIMEOUT_MS);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const xml = await res.text();
      const items = parseRss(xml);
      const data: HeadlinesToolData = { items };

      cache.set(CACHE_KEY, { expires: Date.now() + CACHE_TTL_MS, data });

      trackEvent("assistant.headlines_executed", ctx.userId, ctx.userRole, {
        item_count: items.length,
        success: true,
        cache_hit: false,
      });

      return buildSuccess(data);
    } catch (err) {
      const message = (err as Error).message?.slice(0, 200) ?? "network error";
      trackEvent("assistant.headlines_executed", ctx.userId, ctx.userRole, {
        item_count: 0,
        success: false,
        reason: "external_api_failed",
      });
      return {
        ok: false,
        code: "internal",
        message: `external_api_failed: ${message}`,
      };
    }
  },
};

function buildSuccess(data: HeadlinesToolData): ToolResult<HeadlinesToolData> {
  const widget: WidgetSpec = {
    kind: "headlines",
    title: `Top ${data.items.length} headlines`,
    subtitle: `via ${SOURCE_NAME}`,
    items: data.items,
  };
  const answer =
    data.items.length === 0
      ? "Couldn't load any headlines right now."
      : `Top ${data.items.length} headlines from ${SOURCE_NAME}.`;
  return { ok: true, data, answer, widget };
}

registerTool(headlinesTool);
