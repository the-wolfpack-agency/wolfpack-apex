/** @jest-environment node */
import {
  CRAWLER_SOURCES,
  extractCompactPrefixes,
  fetchCrawlerRanges,
  getCrawlerRanges,
  _resetCrawlerRangesCache,
} from "@/lib/forcefield/crawler-ranges";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";
import { verifyAgentByRanges } from "@/lib/forcefield-web/hosting";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const google = { creationTime: "x", prefixes: [{ ipv6Prefix: "2001:4860:4801::/64" }, { ipv4Prefix: "66.249.64.0/19" }] };

beforeEach(() => _resetCrawlerRangesCache());

describe("crawler-ranges - vendor-published lists for verified-agent identity", () => {
  it("every source maps to an allowlisted agent id (no orphan lists)", () => {
    const ids = new Set(DEFAULT_RULESET.knownAgents.map((a) => a.id));
    for (const s of CRAWLER_SOURCES) {
      expect(s.url).toMatch(/^https:\/\//);
      for (const a of s.agents) expect(ids.has(a)).toBe(true);
    }
  });

  it("extracts IPv4 only, as compact base/bits, skipping garbage", () => {
    expect(extractCompactPrefixes(google)).toEqual([`${(66 << 24 | 249 << 16 | 64 << 8) >>> 0}/19`]);
    expect(extractCompactPrefixes({ prefixes: [{ ipv4Prefix: "nope" }, { ipv4Prefix: 5 }, null] })).toEqual([]);
    expect(extractCompactPrefixes(null)).toEqual([]);
    expect(extractCompactPrefixes({})).toEqual([]);
  });

  it("fetches per source, best-effort: a failing source is just absent", async () => {
    const f = jest.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("common-crawlers")) return json(google);
      if (u.includes("gptbot")) return json({}, 500);
      if (u.includes("bingbot")) throw new Error("down");
      return json({ prefixes: [] });
    }) as unknown as typeof fetch;
    const r = await fetchCrawlerRanges(f);
    expect(Object.keys(r).sort()).toEqual(["Google-CloudVertexBot", "Googlebot"]);
    expect(verifyAgentByRanges("Googlebot", "66.249.66.1", r)).toBe("verified");
    expect(verifyAgentByRanges("Googlebot", "203.0.113.9", r)).toBe("impersonation");
    expect(verifyAgentByRanges("GPTBot", "203.0.113.9", r)).toBe("unverifiable");
  });

  it("getCrawlerRanges: waits when asked, caches, and keeps the last good list when a refresh fails", async () => {
    let up = true;
    const f = jest.fn(async (url: string | URL | Request) => {
      if (!up) throw new Error("down");
      return String(url).includes("common-crawlers") ? json(google) : json({ prefixes: [] });
    }) as unknown as typeof fetch;
    const first = await getCrawlerRanges({ waitMs: 2000, nowMs: 1_000, fetchImpl: f });
    expect(first.Googlebot).toHaveLength(1);
    const calls = (f as unknown as jest.Mock).mock.calls.length;
    await getCrawlerRanges({ nowMs: 2_000, fetchImpl: f }); // fresh: no refetch
    expect((f as unknown as jest.Mock).mock.calls.length).toBe(calls);
    up = false;
    const stale = await getCrawlerRanges({ waitMs: 2000, nowMs: 1_000 + 7 * 3600_000, fetchImpl: f });
    expect(stale.Googlebot).toHaveLength(1); // old list kept, not wiped
  });

  it("getCrawlerRanges without waiting returns {} on a cold cache (never adds latency) and never throws", async () => {
    const f = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch; // hangs
    await expect(getCrawlerRanges({ waitMs: 0, fetchImpl: f })).resolves.toEqual({});
  });
});
