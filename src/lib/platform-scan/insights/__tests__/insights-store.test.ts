/**
 * insights-store round-trip (db mocked).
 *
 * recordInsights UPSERTS one row per insight keyed by the stable dedup `key`
 * (ON CONFLICT (key)) so a re-run never duplicates; listRecentInsights reads recent
 * rows back shaped for the dashboard feed. Both degrade gracefully (writeQuery
 * throw -> the row is skipped, never re-thrown; safeQuery -> [] with no DB) so a
 * store hiccup never loses the insights the engine emitted nor 500s the dashboard.
 */
const mockWriteQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { recordInsights, listRecentInsights } from "@/lib/platform-scan/insights/insights-store";
import type { Insight } from "@/lib/platform-scan/insights/correlate";

const INSIGHT: Insight = {
  kind: "compound_risk",
  severity: "critical",
  modalities: ["performance", "security"],
  members: [
    { platform: "acme", route: "/x", severity: "high", category: "security", title: "a" },
    { platform: "acme", route: "/x", severity: "low", category: "performance", title: "b" },
  ],
  narrative: "Compound risk on /x.",
  platform: "acme",
  key: "compound_risk::acme::/x::performance+security",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteQuery.mockResolvedValue({ rows: [] });
  mockSafeQuery.mockResolvedValue({ rows: [] });
});

describe("recordInsights", () => {
  test("writes one UPSERT row per insight, keyed by `key` (ON CONFLICT key)", async () => {
    const { written } = await recordInsights([INSIGHT]);
    expect(written).toBe(1);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_cross_scan_insights/i);
    expect(sql).toMatch(/ON CONFLICT \(key\) DO UPDATE/i);
    // key is bound; modalities + members are serialized JSON.
    expect(params).toContain(INSIGHT.key);
    expect(params).toContain(JSON.stringify(INSIGHT.modalities));
    expect(params).toContain(JSON.stringify(INSIGHT.members));
  });

  test("re-running with the same insight does NOT change the bound key (dedup by key)", async () => {
    await recordInsights([INSIGHT]);
    await recordInsights([INSIGHT]);
    const firstKey = mockWriteQuery.mock.calls[0][1].at(-1);
    const secondKey = mockWriteQuery.mock.calls[1][1].at(-1);
    expect(firstKey).toBe(secondKey);
  });

  test("a per-row write failure is swallowed; remaining rows still persist", async () => {
    mockWriteQuery
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ rows: [] });
    const second: Insight = { ...INSIGHT, key: "regression::acme::/y::security::SQLi", kind: "regression" };
    const { written } = await recordInsights([INSIGHT, second]);
    expect(written).toBe(1); // first failed, second succeeded; no throw
  });
});

describe("listRecentInsights", () => {
  test("maps rows to the dashboard shape, newest-first via safeQuery", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "xins_1",
          generated_at: "2026-06-28T00:00:00.000Z",
          platform: "acme",
          kind: "compound_risk",
          severity: "critical",
          modalities: ["security", "performance"],
          members: [{ platform: "acme", route: "/x", severity: "high", category: "security", title: "a" }],
          narrative: "n",
          status: "open",
          key: "k1",
        },
      ],
    });
    const rows = await listRecentInsights();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "xins_1",
      kind: "compound_risk",
      severity: "critical",
      platform: "acme",
      status: "open",
    });
    expect(rows[0].modalities).toEqual(["security", "performance"]);
    // ORDER BY generated_at DESC in the read.
    expect(mockSafeQuery.mock.calls[0][0]).toMatch(/ORDER BY generated_at DESC/i);
  });

  test("degrades to [] with no DB (safeQuery returns empty)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await listRecentInsights()).toEqual([]);
  });
});
