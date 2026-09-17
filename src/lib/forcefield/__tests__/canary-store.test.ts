/**
 * Forcefield canary registry - the leak-safety invariants, no DB.
 *
 * The db layer is mocked; the assertions are about what LEAVES the store: the
 * matching path carries the decoy value (for the tripwire), the display path
 * carries only a masked hint (so a management surface can never reveal the
 * decoys and let an attacker route around them).
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { createCanary, listCanariesForMatching, listCanariesForDisplay } from "../canary-store";

const OLD_ENV = process.env.DATABASE_URL;
beforeAll(() => { process.env.DATABASE_URL = "postgres://test"; });
afterAll(() => {
  // Restore precisely: assigning `undefined` sets the STRING "undefined" (truthy).
  if (OLD_ENV === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = OLD_ENV;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [{ id: "cn1", created_at: "2026-09-17T00:00:00Z" }], rowCount: 1 });
});

describe("canary registry", () => {
  it("creates a decoy and returns a MASKED hint, never the value", async () => {
    const d = await createCanary({
      workspaceId: "w1", kind: "token", value: "sk-canary-DECOY-9f3a", seededIn: "customers table", createdBy: "u1",
    });
    expect(d?.valueHint).toBe("****9f3a");
    expect(JSON.stringify(d)).not.toContain("sk-canary-DECOY-9f3a");
    // The full value IS what got inserted, so the tripwire can match it later.
    expect((mockQuery.mock.calls[0][1] as unknown[])[2]).toBe("sk-canary-DECOY-9f3a");
  });

  it("matching path carries the full value in the tripwire Canary shape", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ id: "cn1", kind: "token", value: "sk-canary-DECOY-9f3a", seeded_in: "customers table" }],
    });
    const canaries = await listCanariesForMatching("w1");
    expect(canaries).toEqual([{ id: "cn1", kind: "token", value: "sk-canary-DECOY-9f3a", seededIn: "customers table" }]);
  });

  it("display path is leak-safe: masked hint, and NO full value field", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ id: "cn1", kind: "route", value: "/admin/export-all", seeded_in: "decoy route", active: true, created_at: "2026-09-17T00:00:00Z" }],
    });
    const list = await listCanariesForDisplay("w1");
    expect(Object.keys(list[0]).sort()).toEqual(["active", "createdAt", "id", "kind", "seededIn", "valueHint"]);
    expect(JSON.stringify(list)).not.toContain("/admin/export-all");
    expect(list[0].valueHint).toBe("****-all");
  });

  it("rejects an unknown decoy kind and empty inputs before touching the database", async () => {
    await expect(createCanary({ workspaceId: "w1", kind: "malware" as never, value: "x", seededIn: "y" })).rejects.toThrow(/unknown canary kind/i);
    await expect(createCanary({ workspaceId: "w1", kind: "token", value: "  ", seededIn: "y" })).rejects.toThrow(/value is required/i);
    await expect(createCanary({ workspaceId: "w1", kind: "token", value: "x", seededIn: "" })).rejects.toThrow(/seededIn is required/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("the analytics event never carries the decoy value", async () => {
    await createCanary({ workspaceId: "w1", kind: "token", value: "sk-canary-DECOY-0000", seededIn: "orders", createdBy: "u1" });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "forcefield.canary_seeded", "u1", "agent",
      expect.objectContaining({ workspace_id: "w1", kind: "token", seeded_in: "orders" }),
    );
    expect(JSON.stringify(mockTrackEvent.mock.calls[0][3])).not.toContain("sk-canary-DECOY-0000");
  });
});
