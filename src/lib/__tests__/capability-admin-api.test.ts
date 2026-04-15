/**
 * Admin capability API tests.
 *
 * Covers:
 *   - auth gate (admin.roles.assign required)
 *   - input validation (unknown cap, bad expiry, invalid role)
 *   - happy paths (grant, revoke, role change, effective read)
 *   - expiry is honored end-to-end (expired grant returned as expired-grant)
 *
 * We mock the DB layer so the tests run without Postgres and we can
 * assert exactly what gets persisted.
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

// In-memory "DB" for the admin tests.
let storedRole = "sales";
let storedOverrides: { grants: string[]; revokes: string[]; expires: Record<string, string> } = {
  grants: [],
  revokes: [],
  expires: {},
};

const mockLoadUserOverrides = jest.fn();
const mockSaveUserOverrides = jest.fn();

jest.mock("../auth/capability-overrides", () => {
  const actual = jest.requireActual("../auth/capability-overrides");
  return {
    ...actual,
    loadUserOverrides: (...args: unknown[]) => mockLoadUserOverrides(...args),
    saveUserOverrides: (...args: unknown[]) => mockSaveUserOverrides(...args),
  };
});

// Role route uses the raw DB helpers directly.
const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { POST as GRANT } from "@/app/api/admin/users/[id]/capabilities/grant/route";
import { POST as REVOKE } from "@/app/api/admin/users/[id]/capabilities/revoke/route";
import { GET as EFFECTIVE } from "@/app/api/admin/users/[id]/capabilities/route";
import { POST as ROLE } from "@/app/api/admin/users/[id]/role/route";

function mkReq(body?: unknown, auth = "Bearer x"): import("next/server").NextRequest {
  const headers = new Headers({ authorization: auth, "content-type": "application/json" });
  return new Request("http://test/api/admin/users/u1/capabilities/grant", {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as import("next/server").NextRequest;
}

function asParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  storedRole = "sales";
  storedOverrides = { grants: [], revokes: [], expires: {} };
  process.env.DATABASE_URL = "postgres://fake";

  // Only return a stored record for the target user id "u1". For the
  // caller (admin) we return null so requireCapability falls back to the
  // JWT claim role (set by the test's mockGetUser).
  mockLoadUserOverrides.mockImplementation(async (id: string) => {
    if (id !== "u1") return null;
    return { role: storedRole, overrides: structuredClone(storedOverrides) };
  });
  mockSaveUserOverrides.mockImplementation(async (_id: string, o: typeof storedOverrides) => {
    storedOverrides = structuredClone(o);
    return true;
  });
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe("grant route — auth gate", () => {
  it("401 when no user", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GRANT(mkReq({ capability: "docs.view" }), asParams("u1"));
    expect(res.status).toBe(401);
  });

  it("403 when caller lacks admin.roles.assign", async () => {
    mockGetUser.mockReturnValue({ id: "caller", role: "sales", email: "s", name: "s", created_at: "" });
    const res = await GRANT(mkReq({ capability: "docs.view" }), asParams("u1"));
    expect(res.status).toBe(403);
  });
});

describe("grant route — validation", () => {
  beforeEach(() => {
    mockGetUser.mockReturnValue({ id: "admin1", role: "cto", email: "c", name: "c", created_at: "" });
  });

  it("rejects unknown capability", async () => {
    const res = await GRANT(mkReq({ capability: "not.real" }), asParams("u1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_capability");
  });

  it("rejects malformed expiresAt", async () => {
    const res = await GRANT(
      mkReq({ capability: "docs.view", expiresAt: "not-a-date" }),
      asParams("u1"),
    );
    expect(res.status).toBe(400);
  });

  it("accepts valid ISO expiresAt", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await GRANT(
      mkReq({ capability: "finance.reports.view", expiresAt: future }),
      asParams("u1"),
    );
    expect(res.status).toBe(200);
    expect(storedOverrides.grants).toContain("finance.reports.view");
    expect(storedOverrides.expires["finance.reports.view"]).toBe(future);
  });
});

describe("grant route — analytics + persistence", () => {
  beforeEach(() => {
    mockGetUser.mockReturnValue({ id: "admin1", role: "cto", email: "c", name: "c", created_at: "" });
  });

  it("persists + emits system.capability_granted_override", async () => {
    const res = await GRANT(mkReq({ capability: "docs.view" }), asParams("u1"));
    expect(res.status).toBe(200);
    expect(mockSaveUserOverrides).toHaveBeenCalledWith("u1", expect.objectContaining({
      grants: expect.arrayContaining(["docs.view"]),
    }));
    expect(mockTrack).toHaveBeenCalledWith(
      "system.capability_granted_override",
      "admin1",
      "cto",
      expect.objectContaining({
        capability: "docs.view",
        granted_by: "admin1",
        user_id: "u1",
      }),
    );
  });

  it("is idempotent for repeat grants", async () => {
    await GRANT(mkReq({ capability: "docs.view" }), asParams("u1"));
    await GRANT(mkReq({ capability: "docs.view" }), asParams("u1"));
    expect(storedOverrides.grants.filter((g) => g === "docs.view").length).toBe(1);
  });
});

describe("revoke route", () => {
  beforeEach(() => {
    mockGetUser.mockReturnValue({ id: "admin1", role: "cto", email: "c", name: "c", created_at: "" });
  });

  it("403 without cap", async () => {
    mockGetUser.mockReturnValue({ id: "user1", role: "sales", email: "s", name: "s", created_at: "" });
    const res = await REVOKE(mkReq({ capability: "docs.view" }), asParams("u1"));
    expect(res.status).toBe(403);
  });

  it("rejects unknown capability", async () => {
    const res = await REVOKE(mkReq({ capability: "x.y" }), asParams("u1"));
    expect(res.status).toBe(400);
  });

  it("adds a revoke and emits system.capability_revoked_override", async () => {
    storedRole = "cto"; // so the cap is present by default
    const res = await REVOKE(mkReq({ capability: "docs.edit" }), asParams("u1"));
    expect(res.status).toBe(200);
    expect(storedOverrides.revokes).toContain("docs.edit");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.capability_revoked_override",
      "admin1",
      "cto",
      expect.objectContaining({
        capability: "docs.edit",
        revoked_by: "admin1",
        user_id: "u1",
      }),
    );
  });
});

describe("role change route", () => {
  beforeEach(() => {
    mockGetUser.mockReturnValue({ id: "admin1", role: "cto", email: "c", name: "c", created_at: "" });
  });

  it("403 without admin.roles.assign", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales", email: "s", name: "s", created_at: "" });
    const res = await ROLE(mkReq({ role: "dev" }), asParams("u1"));
    expect(res.status).toBe(403);
  });

  it("rejects invalid role", async () => {
    const res = await ROLE(mkReq({ role: "admin" }), asParams("u1"));
    expect(res.status).toBe(400);
  });

  it("updates role + emits system.role_changed", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ role: "sales" }], fromCache: false });
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    const res = await ROLE(mkReq({ role: "dev" }), asParams("u1"));
    expect(res.status).toBe(200);
    expect(mockTrack).toHaveBeenCalledWith(
      "system.role_changed",
      "admin1",
      "cto",
      expect.objectContaining({
        user_id: "u1",
        from_role: "sales",
        to_role: "dev",
        changed_by: "admin1",
      }),
    );
  });

  it("404 when user not found", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const res = await ROLE(mkReq({ role: "dev" }), asParams("u1"));
    expect(res.status).toBe(404);
  });
});

describe("effective capabilities route", () => {
  beforeEach(() => {
    mockGetUser.mockReturnValue({ id: "admin1", role: "cto", email: "c", name: "c", created_at: "" });
  });

  it("403 without admin.roles.assign", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales", email: "s", name: "s", created_at: "" });
    const req = new Request("http://test/api/admin/users/u1/capabilities") as unknown as import("next/server").NextRequest;
    const res = await EFFECTIVE(req, asParams("u1"));
    expect(res.status).toBe(403);
  });

  it("returns the merged effective set + trace", async () => {
    storedRole = "sales";
    storedOverrides = {
      grants: ["finance.reports.view"],
      revokes: ["clients.edit"],
      expires: {},
    };
    const req = new Request("http://test/api/admin/users/u1/capabilities", {
      headers: { authorization: "Bearer x" },
    }) as unknown as import("next/server").NextRequest;
    const res = await EFFECTIVE(req, asParams("u1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("sales");
    expect(body.effective).toContain("finance.reports.view");
    expect(body.effective).not.toContain("clients.edit");
    const traceByCap = Object.fromEntries(
      body.trace.map((t: { capability: string; source: string }) => [t.capability, t.source]),
    );
    expect(traceByCap["finance.reports.view"]).toBe("grant");
    expect(traceByCap["clients.edit"]).toBe("revoked");
  });

  it("expired grants are reported as expired-grant", async () => {
    storedRole = "sales";
    const past = new Date("2020-01-01T00:00:00Z").toISOString();
    storedOverrides = {
      grants: ["finance.reports.view"],
      revokes: [],
      expires: { "finance.reports.view": past },
    };
    const req = new Request("http://test/api/admin/users/u1/capabilities", {
      headers: { authorization: "Bearer x" },
    }) as unknown as import("next/server").NextRequest;
    const res = await EFFECTIVE(req, asParams("u1"));
    const body = await res.json();
    expect(body.effective).not.toContain("finance.reports.view");
    const traceByCap = Object.fromEntries(
      body.trace.map((t: { capability: string; source: string }) => [t.capability, t.source]),
    );
    expect(traceByCap["finance.reports.view"]).toBe("expired-grant");
  });
});
