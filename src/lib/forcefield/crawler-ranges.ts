/**
 * Crawler / AI-agent IP range FETCHING (server-side), for verified-agent identity.
 *
 * A User-Agent is a free-text claim: anyone can send "Googlebot" or "GPTBot".
 * The vendors that matter publish the IP ranges their crawlers really come from,
 * so a claim can be CHECKED: a UA claiming an agent whose vendor publishes ranges,
 * from an IP inside them, is verified; from outside them, an impersonation. The
 * pure check (verifyAgentByRanges) lives in the PORTABLE edge core
 * (@/lib/forcefield-web/hosting); this module only pulls the vendors' OWN lists
 * and serves them as ruleset.verifiedAgentRanges, so every site verifies against
 * current lists without a re-vendor.
 *
 * Storage: an in-memory cache per server instance (6h TTL, stale-while-
 * revalidate), not a DB table. Unlike the datacenter set (tens of thousands of
 * prefixes, refreshed by a cron into instinct_datacenter_prefixes) these lists
 * are small (~1.5k prefixes total) and are fetched straight from the vendors'
 * CDNs, so a table + cron would add a migration and a scheduled job for no gain.
 * Every source is best-effort: one that fails keeps its last good list, and a
 * vendor with no list leaves its agent "unverifiable" (never an impersonation).
 *
 * Every URL below was confirmed to return JSON with a `prefixes[].ipv4Prefix`
 * array on 2026-10-24.
 */
import { parseCidr } from "@/lib/forcefield-web/hosting";

interface CrawlerSource {
  /** knownAgents ids (DEFAULT_RULESET) these ranges verify. */
  agents: readonly string[];
  url: string;
}

export const CRAWLER_SOURCES: readonly CrawlerSource[] = [
  // Google common crawlers (Googlebot, Google-CloudVertexBot):
  // https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
  { agents: ["Googlebot", "Google-CloudVertexBot"], url: "https://developers.google.com/static/crawling/ipranges/common-crawlers.json" },
  { agents: ["Bingbot"], url: "https://www.bing.com/toolbox/bingbot.json" },
  // OpenAI: https://platform.openai.com/docs/bots
  { agents: ["GPTBot"], url: "https://openai.com/gptbot.json" },
  { agents: ["ChatGPT-User"], url: "https://openai.com/chatgpt-user.json" },
  { agents: ["OAI-SearchBot"], url: "https://openai.com/searchbot.json" },
  // Anthropic, one list for all three agents: https://support.claude.com/en/articles/8896518
  { agents: ["ClaudeBot", "Claude-User", "Claude-SearchBot"], url: "https://claude.com/crawling/bots.json" },
  // Perplexity: https://docs.perplexity.ai/guides/bots
  { agents: ["PerplexityBot"], url: "https://www.perplexity.com/perplexitybot.json" },
  { agents: ["Perplexity-User"], url: "https://www.perplexity.com/perplexity-user.json" },
  { agents: ["Applebot"], url: "https://search.developer.apple.com/applebot.json" },
  { agents: ["DuckDuckBot"], url: "https://duckduckgo.com/duckduckbot.json" },
  // https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot
  { agents: ["DuckAssistBot"], url: "https://duckduckgo.com/duckassistbot.json" },
  // Mistral: https://docs.mistral.ai/robots
  { agents: ["MistralAI-User"], url: "https://mistral.ai/mistralai-user-ips.json" },
  // Not listed (no published JSON today): Amazonbot (HTML page only), Meta's
  // crawlers. They stay "unverifiable".
];

/** Bound per-source size so a hostile or broken response cannot balloon the
 *  ruleset every site downloads. The largest real list today is ~500. */
const MAX_PREFIXES_PER_SOURCE = 5_000;
const TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

/** Extract the IPv4 prefixes of one published list as compact "base/bits". */
export function extractCompactPrefixes(json: unknown): string[] {
  const p = (json as { prefixes?: Array<{ ipv4Prefix?: unknown }> } | null)?.prefixes;
  if (!Array.isArray(p)) return [];
  const out: string[] = [];
  for (const x of p) {
    if (out.length >= MAX_PREFIXES_PER_SOURCE) break;
    const cidr = x && typeof x.ipv4Prefix === "string" ? x.ipv4Prefix : "";
    const parsed = cidr ? parseCidr(cidr) : null;
    if (parsed) out.push(`${parsed.base >>> 0}/${parsed.bits}`);
  }
  return out;
}

/**
 * Fetch every vendor list. Best-effort per source; a failed source is simply
 * absent from the result (the caller keeps its previous value). Never throws.
 */
export async function fetchCrawlerRanges(fetchImpl: typeof fetch = fetch): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  await Promise.all(
    CRAWLER_SOURCES.map(async (src) => {
      try {
        const res = await fetchImpl(src.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
        if (!res.ok) return;
        const prefixes = extractCompactPrefixes(await res.json());
        if (prefixes.length === 0) return;
        for (const agent of src.agents) out[agent] = prefixes;
      } catch {
        // skip this source this run
      }
    }),
  );
  return out;
}

let _cache: { at: number; ranges: Record<string, string[]> } | null = null;
let _inflight: Promise<void> | null = null;

/** Test-only: clear the cache. */
export function _resetCrawlerRangesCache(): void {
  _cache = null;
  _inflight = null;
}

function refresh(nowMs: number, fetchImpl: typeof fetch): Promise<void> {
  if (_inflight) return _inflight;
  _inflight = fetchCrawlerRanges(fetchImpl)
    .then((fresh) => {
      // Merge over the previous set so a source that failed THIS run keeps its
      // last good list instead of silently dropping to "unverifiable".
      _cache = { at: nowMs, ranges: { ...(_cache?.ranges ?? {}), ...fresh } };
    })
    .catch(() => {
      /* keep the old cache */
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

/**
 * The verified-agent ranges for the ruleset. Returns the cached set at once when
 * fresh. When stale or absent it starts ONE background refresh and, if `waitMs`
 * is set, waits up to that long for it (the CDN-cached ruleset route waits; the
 * per-request observe route does not, so a cold instance answers "unverifiable"
 * rather than adding latency). Never throws; {} on any failure.
 */
export async function getCrawlerRanges(
  opts: { waitMs?: number; nowMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, string[]>> {
  try {
    const nowMs = opts.nowMs ?? Date.now();
    if (_cache && nowMs - _cache.at < TTL_MS) return _cache.ranges;
    const p = refresh(nowMs, opts.fetchImpl ?? fetch);
    if (opts.waitMs && opts.waitMs > 0) {
      await Promise.race([p, new Promise((r) => setTimeout(r, opts.waitMs).unref?.())]);
    }
    return _cache?.ranges ?? {};
  } catch {
    return {};
  }
}
