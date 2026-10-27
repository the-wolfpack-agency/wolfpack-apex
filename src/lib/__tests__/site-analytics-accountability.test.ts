/** The board's accountability read: SQL wiring over a mocked safeQuery. */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { getAccountableActions, summarizeAccountability } from "@/lib/site-analytics-accountability";

beforeEach(() => mockSafeQuery.mockReset());

it("folds aggregate rows into per-site class counts and would-hold totals", () => {
  const { totals, sites } = summarizeAccountability([
    { site: "instinct", cls: "browser_session", mandate: null, would_hold: "false", count: "40" },
    { site: "instinct", cls: "unaccountable", mandate: null, would_hold: "true", count: "3" },
    { site: "ogiam.com", cls: "signed_principal", mandate: "within", would_hold: "false", count: 2 },
    { site: "ogiam.com", cls: "signed_principal", mandate: "outside", would_hold: "true", count: "1" },
    { site: "ogiam.com", cls: "bogus", mandate: null, would_hold: "true", count: "99" },
  ]);
  expect(totals).toEqual({ total: 46, browserSession: 40, signedWithin: 2, signedOutside: 1, unaccountable: 3, wouldHold: 4 });
  expect(sites.map((s) => s.site)).toEqual(["instinct", "ogiam.com"]);
});

it("reads only rows with a verdict, excludes synthetic probes, binds the site", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  const r = await getAccountableActions(14, "instinct");
  expect(r).toMatchObject({ available: true, rangeDays: 14, surface: "instinct", sites: [] });
  for (const [sql, params] of mockSafeQuery.mock.calls) {
    expect(sql).toContain("props ? 'accountability'");
    expect(sql).toContain("props->>'synthetic'");
    expect(params).toEqual(["14", "instinct"]);
  }
});

it("a failed read is unavailable (an error on the board), never a zero", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
  expect((await getAccountableActions(30, "all")).available).toBe(false);
});
