/**
 * OGIAM entitlements resolver - query() mocked, no DB. Proves the override wins
 * over the env default, that it FAILS SAFE to the env default on a DB error
 * (never hard-blocks a gate), the env-default flip, the admin set/clear path,
 * and that an unknown feature is refused.
 */
const mockQuery = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { resolveEntitlement, listEntitlements, setEntitlement, envDefault, isKnownFeature } from "../entitlements";

beforeEach(() => { jest.clearAllMocks(); mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); });

describe("envDefault", () => {
  it("is ON by default and flips only for off/false/0", () => {
    expect(envDefault("secure_agent", {} as NodeJS.ProcessEnv)).toBe(true);
    expect(envDefault("forcefield", { OGIAM_FEATURE_FORCEFIELD: "off" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(envDefault("forcefield", { OGIAM_FEATURE_FORCEFIELD: "on" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("resolveEntitlement", () => {
  it("returns the env default when there is no workspace or no override", async () => {
    expect(await resolveEntitlement(null, "secure_agent")).toBe(true);
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await resolveEntitlement("w1", "secure_agent")).toBe(true);
  });

  it("a per-workspace override WINS over the env default", async () => {
    mockQuery.mockResolvedValue({ rows: [{ enabled: false }] });
    expect(await resolveEntitlement("w1", "forcefield")).toBe(false);
  });

  it("an unknown feature returns the (ON) env default and never queries", async () => {
    expect(await resolveEntitlement("w1", "not_a_feature")).toBe(true);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("FAILS SAFE to the env default when the DB throws", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    expect(await resolveEntitlement("w1", "secure_agent")).toBe(true); // never hard-blocks
  });
});

describe("listEntitlements", () => {
  it("returns every OGIAM feature with envDefault + override + effective", async () => {
    mockQuery.mockResolvedValue({ rows: [{ feature: "forcefield", enabled: false }] });
    const list = await listEntitlements("w1");
    const ff = list.find((f) => f.key === "forcefield")!;
    const sa = list.find((f) => f.key === "secure_agent")!;
    expect(ff.override).toBe(false);
    expect(ff.effective).toBe(false); // override wins
    expect(sa.override).toBeNull();
    expect(sa.effective).toBe(true); // env default
  });
});

describe("setEntitlement", () => {
  const actor = { workspaceId: "w1", userId: "u1", role: "admin" };
  it("refuses an unknown feature (no write)", async () => {
    expect(await setEntitlement(actor, "nope", false)).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("refuses without a workspace", async () => {
    expect(await setEntitlement({ ...actor, workspaceId: "" }, "forcefield", false)).toBe(false);
  });
  it("upserts an override and audits it", async () => {
    expect(await setEntitlement(actor, "forcefield", false)).toBe(true);
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO instinct_org_entitlements/);
    expect(mockTrack).toHaveBeenCalledWith("tenancy.entitlement_changed", "u1", "admin", expect.objectContaining({ workspace_id: "w1", feature: "forcefield", enabled: "false" }));
  });
  it("enabled=null CLEARS the override (revert to env default)", async () => {
    expect(await setEntitlement(actor, "forcefield", null)).toBe(true);
    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM instinct_org_entitlements/);
    expect(mockTrack).toHaveBeenCalledWith("tenancy.entitlement_changed", "u1", "admin", expect.objectContaining({ enabled: "cleared" }));
  });
});

describe("isKnownFeature", () => {
  it("knows the two OGIAM products", () => {
    expect(isKnownFeature("secure_agent")).toBe(true);
    expect(isKnownFeature("forcefield")).toBe(true);
    expect(isKnownFeature("random")).toBe(false);
  });
});
