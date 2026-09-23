/** @jest-environment node */
import { getBlockedFingerprints, captureBlockedFingerprints, clearBlockedFingerprints } from "@/lib/forcefield/blocked-fingerprints";

const mockQuery = jest.fn();
const mockListBlocked = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/agent-operators", () => ({ listBlockedOperatorKeys: (...a: unknown[]) => mockListBlocked(...a) }));

const ORIG = process.env.DATABASE_URL;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = "postgres://x";
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIG;
});

describe("getBlockedFingerprints", () => {
  it("returns ONLY the fingerprints whose operator is still blocked", async () => {
    mockListBlocked.mockResolvedValue(new Set(["op_blocked"]));
    mockQuery.mockResolvedValue({
      rows: [
        { fp: "aaaa", operator_key: "op_blocked" }, // kept
        { fp: "bbbb", operator_key: "op_blocked" }, // kept
        { fp: "cccc", operator_key: "op_stale" }, // dropped: operator no longer blocked
      ],
    });
    const fps = await getBlockedFingerprints("default");
    expect(fps.sort()).toEqual(["aaaa", "bbbb"]);
  });

  it("returns empty when there are no blocked fingerprints (admin or auto)", async () => {
    mockListBlocked.mockResolvedValue(new Set());
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getBlockedFingerprints("default")).toEqual([]);
  });

  it("serves auto-blocked (honeytoken) fingerprints unconditionally, even with no admin-blocked operators", async () => {
    mockListBlocked.mockResolvedValue(new Set());
    mockQuery.mockResolvedValue({
      rows: [
        { fp: "auto1", operator_key: "auto:honeytoken" }, // kept: auto-block enforces on its own
        { fp: "op_only", operator_key: "op_notblocked" }, // dropped: operator not admin-blocked
      ],
    });
    expect(await getBlockedFingerprints("default")).toEqual(["auto1"]);
  });

  it("fail-safe: returns empty on a DB error (never serves a wrong block list)", async () => {
    mockListBlocked.mockRejectedValue(new Error("db down"));
    expect(await getBlockedFingerprints("default")).toEqual([]);
  });

  it("returns empty without a database configured", async () => {
    delete process.env.DATABASE_URL;
    expect(await getBlockedFingerprints("default")).toEqual([]);
  });
});

describe("captureBlockedFingerprints", () => {
  it("is a no-op (0) when no events map to the operator", async () => {
    // resolveOperatorFingerprints -> loadJourneysWithFingerprints queries events;
    // no rows -> no fingerprints -> nothing inserted.
    mockQuery.mockResolvedValue({ rows: [] });
    const n = await captureBlockedFingerprints("default", "op_x");
    expect(n).toBe(0);
  });

  it("returns 0 without a database (no throw)", async () => {
    delete process.env.DATABASE_URL;
    expect(await captureBlockedFingerprints("default", "op_x")).toBe(0);
  });
});

describe("clearBlockedFingerprints", () => {
  it("deletes the operator's rows", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await clearBlockedFingerprints("default", "op_x");
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM instinct_agent_blocked_fingerprints"), ["default", "op_x"]);
  });
});
