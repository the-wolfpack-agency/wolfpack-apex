/** @jest-environment node */
/**
 * Forcefield tenant registry: the multi-tenant identity primitive. Pins that a
 * token round-trips to its tenant, that tokens are stored HASHED (never raw),
 * that a wrong/disabled token resolves to nothing, and that a listing never leaks
 * a token.
 */
import {
  createForcefieldTenant, resolveTenantByToken, listForcefieldTenants,
  generateTenantToken, hashToken, type TenantQuery,
} from "../tenants";

const ROW = { id: "t1", name: "Before U Trade", site_label: "beforeutrade", status: "active", created_at: "2026-10-06T00:00:00Z" };

describe("tokens", () => {
  it("generates a prefixed, high-entropy token and hashes deterministically", () => {
    const a = generateTenantToken(), b = generateTenantToken();
    expect(a.startsWith("ff_")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
});

describe("createForcefieldTenant", () => {
  it("stores the HASH (not the raw token) and returns the raw token exactly once", async () => {
    let storedHash = "", returnedToken = "";
    const q: TenantQuery = async (sql, params) => {
      expect(sql).toContain("INSERT INTO forcefield_tenants");
      storedHash = (params as string[])[2];
      return [ROW] as never;
    };
    const res = await createForcefieldTenant({ name: "Before U Trade", siteLabel: "beforeutrade" }, q);
    expect(res).not.toBeNull();
    returnedToken = res!.token;
    expect(returnedToken.startsWith("ff_")).toBe(true);
    // what was written is the HASH of the returned token, never the token itself
    expect(storedHash).toBe(hashToken(returnedToken));
    expect(storedHash).not.toContain(returnedToken);
    expect(res!.tenant.siteLabel).toBe("beforeutrade");
  });

  it("rejects an empty or too-short name/site without writing", async () => {
    let called = false;
    const q: TenantQuery = async () => { called = true; return []; };
    expect(await createForcefieldTenant({ name: "", siteLabel: "x" }, q)).toBeNull();
    expect(await createForcefieldTenant({ name: "ok", siteLabel: "" }, q)).toBeNull();
    expect(called).toBe(false);
  });
});

describe("resolveTenantByToken", () => {
  it("resolves an active tenant by the token HASH, scoped to active only", async () => {
    const token = "ff_sometoken";
    const q: TenantQuery = async (sql, params) => {
      expect(sql).toContain("status = 'active'");
      expect((params as string[])[0]).toBe(hashToken(token)); // hash, not raw
      return [ROW] as never;
    };
    const t = await resolveTenantByToken(token, q);
    expect(t?.id).toBe("t1");
    expect(t?.siteLabel).toBe("beforeutrade");
  });

  it("returns null for an empty token without a query, and for no match", async () => {
    let called = false;
    const none: TenantQuery = async () => { called = true; return []; };
    expect(await resolveTenantByToken("", none)).toBeNull();
    expect(called).toBe(false);
    expect(await resolveTenantByToken("ff_unknown", async () => [])).toBeNull();
  });

  it("never throws: a DB error resolves to null (ingest then uses shared-token path)", async () => {
    expect(await resolveTenantByToken("ff_x", async () => { throw new Error("db down"); })).toBeNull();
  });
});

describe("listForcefieldTenants", () => {
  it("lists tenants and never includes a token or its hash", async () => {
    const q: TenantQuery = async (sql) => {
      expect(sql).not.toMatch(/token/i); // the SELECT must not touch the token column
      return [ROW] as never;
    };
    const list = await listForcefieldTenants(q);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/token/i);
  });
});

describe("token lifecycle: setTenantStatus + rotateTenantToken", () => {
  it("setTenantStatus writes the status and returns true when a row updates", async () => {
    const { setTenantStatus } = await import("../tenants");
    const q = jest.fn().mockResolvedValueOnce([{ id: "t1" }]);
    expect(await setTenantStatus("t1", "disabled", q)).toBe(true);
    expect(q.mock.calls[0][0]).toMatch(/UPDATE forcefield_tenants SET status/);
    expect(q.mock.calls[0][1]).toEqual(["t1", "disabled"]);
  });
  it("setTenantStatus returns false for an unknown id and never throws", async () => {
    const { setTenantStatus } = await import("../tenants");
    expect(await setTenantStatus("x", "active", jest.fn().mockResolvedValueOnce([]))).toBe(false);
    expect(await setTenantStatus("x", "active", jest.fn().mockRejectedValueOnce(new Error("db")))).toBe(false);
  });
  it("rotateTenantToken issues a new ff_ token, stores its hash, returns it once", async () => {
    const { rotateTenantToken } = await import("../tenants");
    const q = jest.fn().mockResolvedValueOnce([{ id: "t1" }]);
    const res = await rotateTenantToken("t1", q);
    expect(res?.token).toMatch(/^ff_/);
    // stores a hash, never the raw token
    const storedHash = q.mock.calls[0][1][1];
    expect(storedHash).not.toEqual(res?.token);
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rotateTenantToken returns null for an unknown id and never throws", async () => {
    const { rotateTenantToken } = await import("../tenants");
    expect(await rotateTenantToken("x", jest.fn().mockResolvedValueOnce([]))).toBeNull();
    expect(await rotateTenantToken("x", jest.fn().mockRejectedValueOnce(new Error("db")))).toBeNull();
  });
});
