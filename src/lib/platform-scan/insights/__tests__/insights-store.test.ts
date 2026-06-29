/**
 * insights-store round-trip (db mocked).
 *
 * recordInsights UPSERTS one row per insight keyed by the TENANT-SCOPED conflict
 * target (workspace_id, key) so a re-run never duplicates AND two workspaces that
 * share a key stay isolated (FIX 2); listRecentInsights reads recent rows back for
 * a SPECIFIC workspace (filtered by workspace_id). Both degrade gracefully
 * (writeQuery throw -> the row is skipped, never re-thrown; safeQuery -> [] with no
 * DB) so a store hiccup never loses the insights the engine emitted nor 500s the
 * dashboard.
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
  key: "compound_risk::deadbeef",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteQuery.mockResolvedValue({ rows: [] });
  mockSafeQuery.mockResolvedValue({ rows: [] });
});

describe("recordInsights", () => {
  test("writes one UPSERT row per insight, conflict target (workspace_id, key)", async () => {
    const { written } = await recordInsights([INSIGHT], "ws-1");
    expect(written).toBe(1);
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_cross_scan_insights/i);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, key\) DO UPDATE/i);
    // workspace_id + key are bound; modalities + members are serialized JSON.
    expect(params).toContain("ws-1");
    expect(params).toContain(INSIGHT.key);
    expect(params).toContain(JSON.stringify(INSIGHT.modalities));
    expect(params).toContain(JSON.stringify(INSIGHT.members));
  });

  test("FIX 2: same key in two DIFFERENT workspaces produces DISTINCT ids (no overwrite)", async () => {
    await recordInsights([INSIGHT], "ws-A");
    await recordInsights([INSIGHT], "ws-B");
    const idA = mockWriteQuery.mock.calls[0][1][0]; // first bound param is the id
    const idB = mockWriteQuery.mock.calls[1][1][0];
    expect(idA).not.toBe(idB); // tenant-namespaced id -> no cross-tenant clobber
    expect(idA).toContain("ws-A");
    expect(idB).toContain("ws-B");
    // The workspace_id bound param differs too.
    expect(mockWriteQuery.mock.calls[0][1]).toContain("ws-A");
    expect(mockWriteQuery.mock.calls[1][1]).toContain("ws-B");
  });

  test("re-running with the same insight + workspace does NOT change the bound id (dedup)", async () => {
    await recordInsights([INSIGHT], "ws-1");
    await recordInsights([INSIGHT], "ws-1");
    expect(mockWriteQuery.mock.calls[0][1][0]).toBe(mockWriteQuery.mock.calls[1][1][0]);
  });

  test("a per-row write failure is swallowed; remaining rows still persist", async () => {
    mockWriteQuery
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ rows: [] });
    const second: Insight = { ...INSIGHT, key: "regression::cafebabe", kind: "regression" };
    const { written } = await recordInsights([INSIGHT, second], "ws-1");
    expect(written).toBe(1);
  });
});

describe("listRecentInsights", () => {
  test("reads ONLY the given workspace's rows, newest-first via safeQuery", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        {
          id: "xins_ws-1_k1",
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
    const rows = await listRecentInsights("ws-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "compound_risk", platform: "acme", status: "open" });
    // FIX 2: the read is filtered by workspace_id and bound to the given workspace.
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE workspace_id = \$1/i);
    expect(sql).toMatch(/ORDER BY generated_at DESC/i);
    expect(params[0]).toBe("ws-1");
  });

  test("degrades to [] with no DB (safeQuery returns empty)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await listRecentInsights("ws-1")).toEqual([]);
  });
});
