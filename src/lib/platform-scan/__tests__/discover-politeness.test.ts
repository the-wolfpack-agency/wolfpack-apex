/**
 * Discovery politeness: the sitemap fetch flows through the same per-host
 * politeness layer, so if a client's host is throttling, discovery backs off and
 * honors Retry-After instead of hammering. Deterministic fake clock/sleep.
 */
import { discoverRoutes } from "../discover";

const BASE = "https://wolfpack-auto.vercel.app";
const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>${BASE}/inventory</loc></url></urlset>`;

function fakeTime(start = 0) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, get current() { return t; } };
}

describe("discoverRoutes politeness", () => {
  it("backs off on a 429 then retries and parses the sitemap", async () => {
    const clk = fakeTime();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return { status: 429, headers: new Headers({ "retry-after": "2" }), ok: false } as unknown as Response;
      }
      return new Response(SITEMAP, { status: 200 });
    }) as unknown as typeof fetch;

    const onThrottle = jest.fn();
    const specs = await discoverRoutes(BASE, fetchImpl, {
      minGapMs: 0,
      now: clk.now,
      sleep: clk.sleep,
      onThrottle,
    });

    expect(call).toBe(2); // retried after the 429
    expect(clk.current).toBeGreaterThanOrEqual(2000); // honored Retry-After
    expect(specs.map((s) => s.path)).toEqual(["/inventory"]);
    expect(onThrottle).toHaveBeenCalledWith(
      expect.objectContaining({ host: "wolfpack-auto.vercel.app", reason: "429" }),
    );
  });

  it("still returns [] on a persistent 503 once retries are exhausted (graceful fallback)", async () => {
    const clk = fakeTime();
    const fetchImpl = (async () =>
      ({ status: 503, headers: new Headers(), ok: false } as unknown as Response)) as unknown as typeof fetch;

    const specs = await discoverRoutes(BASE, fetchImpl, {
      maxRetries: 1,
      minGapMs: 0,
      now: clk.now,
      sleep: clk.sleep,
    });
    // !res.ok -> [] (falls back to the seed manifest); no throw, no infinite loop.
    expect(specs).toEqual([]);
  });
});
