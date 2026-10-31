/** @jest-environment node */
import { ALERT_MIN_PAGES, ALERT_MIN_SESSIONS, foldIntegrity, getPageIntegrity, recordIntegrityReports, validReports, type IntegrityRow } from "@/lib/forcefield/page-integrity";

const DAY = 86400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const row = (o: Partial<IntegrityRow> & { blocked_origin: string; first_seen: string }): IntegrityRow => ({
  directive: "script-src", last_seen: o.first_seen, reports: 1, sessions: 1, pages: 1, sessions_24h: 0, pages_24h: 0, top_page: "/", ...o,
});

describe("validReports (server-side validation of what a site sent)", () => {
  it("keeps only a known directive, an origin and a page path", () => {
    expect(validReports([
      { directive: "script-src", blockedOrigin: "https://CDN.example", page: "/a" },
      { directive: "img-src", blockedOrigin: "https://x.example", page: "/" },
      { directive: "connect-src", blockedOrigin: "https://x.example/path?q=1", page: "/" },
      { directive: "frame-src", blockedOrigin: "javascript:alert(1)", page: "/" },
      { directive: "form-action", blockedOrigin: "data", page: "no-slash" },
      null,
    ])).toEqual([
      { directive: "script-src", blockedOrigin: "https://cdn.example", page: "/a" },
      { directive: "form-action", blockedOrigin: "data", page: "/" },
    ]);
    expect(validReports("x")).toEqual([]);
  });
});

describe("recordIntegrityReports", () => {
  it("upserts one counted row per report for a valid scope", async () => {
    const calls: unknown[][] = [];
    const q = async (t: string, p: unknown[]) => { calls.push([t, p]); return { rows: [] }; };
    expect(await recordIntegrityReports("site:aidanmulready", "ab12cd34", [{ directive: "script-src", blockedOrigin: "https://a.example", page: "/" }], q)).toBe(1);
    expect(String(calls[0][0])).toMatch(/ON CONFLICT .* DO UPDATE SET reports = forcefield_page_integrity\.reports \+ 1/s);
    expect(calls[0][1]).toEqual(["site:aidanmulready", "script-src", "https://a.example", "ab12cd34", "/"]);
  });
  it("stores nothing for a bad scope or no valid reports, and 0 on a store error", async () => {
    const q = jest.fn(async () => ({ rows: [] }));
    expect(await recordIntegrityReports("anything", "s", [{ directive: "script-src", blockedOrigin: "https://a.example", page: "/" }], q)).toBe(0);
    expect(await recordIntegrityReports("site:s", "s", [], q)).toBe(0);
    expect(q).not.toHaveBeenCalled();
    expect(await recordIntegrityReports("site:s", "s", [{ directive: "script-src", blockedOrigin: "https://a.example", page: "/" }], async () => { throw new Error("db"); })).toBe(0);
  });
  it("a malformed session signature is stored as '-', never as given", async () => {
    const calls: unknown[][] = [];
    await recordIntegrityReports("site:s", "<script>", [{ directive: "script-src", blockedOrigin: "https://a.example", page: "/" }], async (_t, p) => { calls.push(p); return { rows: [] }; });
    expect(calls[0][3]).toBe("-");
  });
});

describe("foldIntegrity", () => {
  it("no rows: no learning window yet (the empty state)", () => {
    expect(foldIntegrity([], T0)).toEqual({ learning: null, origins: [], totals: { origins: 0, newOrigins: 0, wouldAlert: 0 } });
  });
  it("the first 7 days are the baseline, and nothing in them is new", () => {
    const r = foldIntegrity([row({ blocked_origin: "https://fonts.example", first_seen: new Date(T0).toISOString() }), row({ blocked_origin: "https://late.example", first_seen: new Date(T0 + 6 * DAY).toISOString() })], T0 + 3 * DAY);
    expect(r.learning).toEqual({ startedAt: new Date(T0).toISOString(), endsAt: new Date(T0 + 7 * DAY).toISOString(), active: true });
    expect(r.origins.every((o) => o.status === "baseline")).toBe(true);
  });
  it("after the baseline: a new origin alerts only with enough sessions AND pages in 24 hours", () => {
    const base = row({ blocked_origin: "https://fonts.example", first_seen: new Date(T0).toISOString(), sessions: 900 });
    const ext = row({ blocked_origin: "https://extension-like.example", first_seen: new Date(T0 + 9 * DAY).toISOString(), sessions_24h: 1, pages_24h: 6 });
    const onePage = row({ blocked_origin: "https://one-page.example", first_seen: new Date(T0 + 9 * DAY).toISOString(), sessions_24h: 40, pages_24h: 1 });
    const skimmer = row({ blocked_origin: "https://skim.example", first_seen: new Date(T0 + 9 * DAY).toISOString(), sessions_24h: ALERT_MIN_SESSIONS, pages_24h: ALERT_MIN_PAGES, sessions: 5 });
    const r = foldIntegrity([base, ext, onePage, skimmer], T0 + 10 * DAY);
    expect(r.learning?.active).toBe(false);
    expect(r.origins.map((o) => [o.origin, o.status, o.wouldAlert])).toEqual([
      ["https://skim.example", "new", true],
      ["https://extension-like.example", "new", false],
      ["https://one-page.example", "new", false],
      ["https://fonts.example", "baseline", false],
    ]);
    expect(r.totals).toEqual({ origins: 4, newOrigins: 3, wouldAlert: 1 });
  });
  it("a baseline origin never alerts, however busy", () => {
    const r = foldIntegrity([row({ blocked_origin: "https://cdn.example", first_seen: new Date(T0).toISOString(), sessions_24h: 500, pages_24h: 50 })], T0 + 30 * DAY);
    expect(r.origins[0]).toMatchObject({ status: "baseline", wouldAlert: false });
  });
});

describe("getPageIntegrity", () => {
  it("reads one scope, and an unreadable store or bad scope reads empty (never throws)", async () => {
    const q = jest.fn(async (..._a: unknown[]) => ({ rows: [row({ blocked_origin: "https://a.example", first_seen: new Date(T0).toISOString() })] as unknown as Array<Record<string, unknown>> }));
    const r = await getPageIntegrity("site:aidanmulready", { q, nowMs: T0 + DAY });
    expect(q.mock.calls[0][1]).toEqual(["site:aidanmulready"]);
    expect(r.origins).toHaveLength(1);
    expect((await getPageIntegrity("site:x", { q: async () => { throw new Error("db"); } })).learning).toBeNull();
    expect((await getPageIntegrity("nope", { q })).origins).toEqual([]);
    expect(q).toHaveBeenCalledTimes(1);
  });
});
