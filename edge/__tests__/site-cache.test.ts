/** @jest-environment node */
/**
 * The Edge hostname cache: positive / negative TTLs, one in-flight lookup per
 * hostname, stale-if-error so an apex outage never takes a client site down,
 * and a strict record check (a 200 that does not validate is never served).
 */
import { lookupEdgeSite, _resetSiteCache, POSITIVE_TTL_MS, NEGATIVE_TTL_MS, STALE_IF_ERROR_MS } from "../lib/site-cache";

const SITE = { tenantId: "t", siteLabel: "client.example", originUrl: "https://o.client.example", originSecret: "ffe_" + "x".repeat(43), enforce: false };

function cfg(f: jest.Mock, now: { t: number }) {
  return { siteUrl: "https://apex.example/api/forcefield/edge/site", serviceToken: "tok", fetchImpl: f as unknown as typeof fetch, nowMs: () => now.t };
}

beforeEach(() => _resetSiteCache());

it("not_configured without the endpoint or token", async () => {
  const f = jest.fn();
  expect(await lookupEdgeSite("a.example", { siteUrl: "", serviceToken: "tok", fetchImpl: f as never })).toEqual({ ok: false, error: "not_configured" });
  expect(f).not.toHaveBeenCalled();
});

it("caches a known hostname for the positive TTL, then refreshes", async () => {
  const now = { t: 1_000 };
  const f = jest.fn(async () => Response.json({ ok: true, site: SITE }));
  expect(await lookupEdgeSite("a.example", cfg(f, now))).toEqual({ ok: true, site: SITE, source: "live" });
  now.t += POSITIVE_TTL_MS - 1;
  expect((await lookupEdgeSite("a.example", cfg(f, now))).ok && (await lookupEdgeSite("a.example", cfg(f, now)))).toMatchObject({ source: "cache" });
  expect(f).toHaveBeenCalledTimes(1);
  now.t += 2;
  await lookupEdgeSite("a.example", cfg(f, now));
  expect(f).toHaveBeenCalledTimes(2);
  expect(String((f.mock.calls[0] as unknown[])[0])).toBe("https://apex.example/api/forcefield/edge/site?host=a.example");
});

it("negative-caches an unknown hostname for the shorter TTL", async () => {
  const now = { t: 0 };
  const f = jest.fn(async () => new Response("{}", { status: 404 }));
  expect(await lookupEdgeSite("stray.example", cfg(f, now))).toEqual({ ok: true, site: null, source: "live" });
  now.t += NEGATIVE_TTL_MS - 1;
  expect(await lookupEdgeSite("stray.example", cfg(f, now))).toEqual({ ok: true, site: null, source: "cache" });
  now.t += 2;
  await lookupEdgeSite("stray.example", cfg(f, now));
  expect(f).toHaveBeenCalledTimes(2);
});

it("concurrent lookups for one hostname share a single request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = jest.fn(async () => {
    await gate;
    return Response.json({ ok: true, site: SITE });
  });
  const now = { t: 0 };
  const all = Promise.all([lookupEdgeSite("a.example", cfg(f, now)), lookupEdgeSite("a.example", cfg(f, now)), lookupEdgeSite("a.example", cfg(f, now))]);
  release();
  const results = await all;
  expect(f).toHaveBeenCalledTimes(1);
  for (const r of results) expect(r).toMatchObject({ ok: true, site: SITE });
});

it("stale-if-error: apex down -> the last known record, for a bounded time only", async () => {
  const now = { t: 0 };
  const up = jest.fn(async () => Response.json({ ok: true, site: SITE }));
  await lookupEdgeSite("a.example", cfg(up, now));
  const down = jest.fn(async () => {
    throw new Error("ECONNREFUSED");
  });
  now.t += POSITIVE_TTL_MS + 1;
  expect(await lookupEdgeSite("a.example", cfg(down, now))).toEqual({ ok: true, site: SITE, source: "stale" });
  now.t += STALE_IF_ERROR_MS;
  expect(await lookupEdgeSite("a.example", cfg(down, now))).toEqual({ ok: false, error: "unavailable" });
});

it("a 200 whose record does not validate is treated as unknown (never served)", async () => {
  const f = jest.fn(async () => Response.json({ ok: true, site: { ...SITE, originUrl: "http://o.client.example" } }));
  expect(await lookupEdgeSite("a.example", cfg(f, { t: 0 }))).toEqual({ ok: true, site: null, source: "live" });
});

it("a 5xx with nothing cached is unavailable (the edge answers 502, not an open forward)", async () => {
  const f = jest.fn(async () => new Response("x", { status: 503 }));
  expect(await lookupEdgeSite("a.example", cfg(f, { t: 0 }))).toEqual({ ok: false, error: "unavailable" });
});
