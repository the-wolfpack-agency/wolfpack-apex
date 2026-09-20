/** Gating is the whole point: nothing is shared or read unless the workspace
 *  opted in, and a reader never sees its own reports. The db is mocked. */
const query = jest.fn();
const safeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => query(...a),
  safeQuery: (...a: unknown[]) => safeQuery(...a),
  hasDatabase: () => true,
}));

import { contributeHostileOperator, getNetworkReputation } from "@/lib/forcefield/operator-reputation";

function optIn(contribute: boolean, consume: boolean) {
  safeQuery.mockResolvedValueOnce({ rows: [{ contribute, consume }] }); // getReputationOptIn
}

beforeEach(() => { query.mockReset(); safeQuery.mockReset(); query.mockResolvedValue({ rows: [] }); });

describe("operator reputation - opt-in gating", () => {
  it("does NOT contribute a block when the workspace has not opted in", async () => {
    optIn(false, false);
    await contributeHostileOperator({ workspaceId: "w1", operatorKey: "op_x", severity: "hostile" });
    expect(query).not.toHaveBeenCalled(); // nothing written
  });

  it("contributes when opted in to contribute (upsert keyed on op + workspace)", async () => {
    optIn(true, false);
    await contributeHostileOperator({ workspaceId: "w1", operatorKey: "op_x", severity: "hostile" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toMatch(/INSERT INTO instinct_operator_reputation/);
    expect(query.mock.calls[0][1]).toEqual(["op_x", "w1", "hostile", [], []]);
  });

  it("returns {} from the network read when not opted in to consume", async () => {
    optIn(false, false);
    const r = await getNetworkReputation("w1", ["op_x"]);
    expect(r).toEqual({});
    expect(safeQuery).toHaveBeenCalledTimes(1); // only the opt-in check, no network read
  });

  it("reads OTHERS' reports when opted in to consume, excluding the caller", async () => {
    optIn(false, true);
    safeQuery.mockResolvedValueOnce({ rows: [{ operator_key: "op_x", other_workspaces: "3", sev_rank: 3 }] });
    const r = await getNetworkReputation("w1", ["op_x"]);
    expect(r.op_x).toEqual({ operatorKey: "op_x", otherWorkspaces: 3, severity: "hostile", ttps: [] });
    // the network query excludes the caller's own workspace
    const call = safeQuery.mock.calls[1];
    expect(String(call[0])).toMatch(/workspace_id <> \$2/);
    expect(call[1]).toEqual([["op_x"], "w1"]);
  });

  it("contributes the behavioral signature (behavior classes + tells), not just the fingerprint", async () => {
    optIn(true, false);
    await contributeHostileOperator({
      workspaceId: "w1",
      operatorKey: "op_x",
      severity: "hostile",
      behaviorClasses: ["aggressive_scraper", "exploit_attempt"],
      tells: ["tripped_decoy", "payload_attack", "id_enumeration"],
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toMatch(/behavior_classes, tells/);
    expect(query.mock.calls[0][1]).toEqual([
      "op_x", "w1", "hostile",
      ["aggressive_scraper", "exploit_attempt"],
      ["tripped_decoy", "payload_attack", "id_enumeration"],
    ]);
  });

  it("surfaces the shared TTPs (deduped tradecraft) on the network read", async () => {
    optIn(false, true);
    safeQuery.mockResolvedValueOnce({
      rows: [{ operator_key: "op_x", other_workspaces: "2", hostile_reporters: "2", sev_rank: 3, ttps: ["payload_attack", "id_enumeration", "tripped_decoy"] }],
    });
    const r = await getNetworkReputation("w1", ["op_x"]);
    expect(r.op_x.severity).toBe("hostile");
    expect(r.op_x.ttps).toEqual(["payload_attack", "id_enumeration", "tripped_decoy"]);
    // the read aggregates behavior_classes || tells across the group
    expect(String(safeQuery.mock.calls[1][0])).toMatch(/behavior_classes \|\| r\.tells/);
  });

  it("returns {} for an empty key set without touching the db", async () => {
    expect(await getNetworkReputation("w1", [])).toEqual({});
    expect(safeQuery).not.toHaveBeenCalled();
  });
});
