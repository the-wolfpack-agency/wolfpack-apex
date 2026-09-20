/** @jest-environment node */
const safeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ hasDatabase: () => true, query: jest.fn(), safeQuery: (...a: unknown[]) => safeQuery(...a) }));
import { getNetworkReputation } from "@/lib/forcefield/operator-reputation";

// getReputationOptIn (consume) is the first safeQuery; the network read is the second.
function optInConsume() { safeQuery.mockResolvedValueOnce({ rows: [{ contribute: false, consume: true }], fromCache: false }); }
function netRow(hostileReporters: number, others: number, sevRank = 3) {
  safeQuery.mockResolvedValueOnce({ rows: [{ operator_key: "op_x", other_workspaces: String(others), hostile_reporters: String(hostileReporters), sev_rank: sevRank }], fromCache: false });
}
beforeEach(() => safeQuery.mockReset());

describe("reputation corroboration (Sybil resistance)", () => {
  it("a SINGLE hostile reporter is downgraded to elevated (challenge), not hostile", async () => {
    optInConsume(); netRow(1, 1);
    const r = await getNetworkReputation("w-caller", ["op_x"]);
    expect(r.op_x.severity).toBe("elevated");
  });

  it("TWO or more distinct hostile reporters corroborate a hostile verdict", async () => {
    optInConsume(); netRow(2, 2);
    const r = await getNetworkReputation("w-caller", ["op_x"]);
    expect(r.op_x.severity).toBe("hostile");
  });

  it("reporters that are not hostile stay elevated/benign, never escalated", async () => {
    optInConsume(); netRow(0, 3, 2);
    const r = await getNetworkReputation("w-caller", ["op_x"]);
    expect(r.op_x.severity).toBe("elevated");
  });
});
