/** @jest-environment node */
const query = jest.fn();
const safeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => query(...a), safeQuery: (...a: unknown[]) => safeQuery(...a) }));

import { setFindingTriage, getFindingTriage, isTriageStatus, TRIAGE_STATUSES } from "@/lib/site-finding-triage";

beforeEach(() => { query.mockReset(); safeQuery.mockReset(); });

describe("site finding triage", () => {
  it("validates the status vocabulary", () => {
    for (const s of TRIAGE_STATUSES) expect(isTriageStatus(s)).toBe(true);
    expect(isTriageStatus("bogus")).toBe(false);
    expect(isTriageStatus(3)).toBe(false);
  });

  it("upserts with the workspace + finding key and the actor", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await setFindingTriage({ workspaceId: "w1", findingKey: "fp1", status: "escalated", note: "real threat", updatedBy: "u1" });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_site_finding_triage/);
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, finding_key\)/);
    expect(params).toEqual(["w1", "fp1", "escalated", "real threat", "u1"]);
  });

  it("reads triage state for the given finding keys, keyed by finding", async () => {
    safeQuery.mockResolvedValueOnce({ rows: [
      { finding_key: "fp1", status: "escalated", note: "x", updated_at: "2026-09-19T00:00:00Z" },
      { finding_key: "fp2", status: "dismissed", note: null, updated_at: "2026-09-19T00:01:00Z" },
    ] });
    const map = await getFindingTriage("w1", ["fp1", "fp2"]);
    expect(map.fp1.status).toBe("escalated");
    expect(map.fp2.status).toBe("dismissed");
    // narrowed query carries the workspace + the key array
    expect(safeQuery.mock.calls[0][1]).toEqual(["w1", ["fp1", "fp2"]]);
  });

  it("drops rows with an unknown status (defensive)", async () => {
    safeQuery.mockResolvedValueOnce({ rows: [{ finding_key: "fp1", status: "weird", note: null, updated_at: "t" }] });
    expect(await getFindingTriage("w1", ["fp1"])).toEqual({});
  });

  it("falls back to the recent-scan query when no keys are given", async () => {
    safeQuery.mockResolvedValueOnce({ rows: [] });
    await getFindingTriage("w1");
    expect(safeQuery.mock.calls[0][0]).toMatch(/ORDER BY updated_at DESC LIMIT 500/);
  });
});
