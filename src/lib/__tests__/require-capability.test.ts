/**
 * Unit tests for `requireCapability` + `hasCapability`.
 *
 * Strategy: mock `getUserFromRequest` so we control identity, and mock
 * `loadUserOverrides` so we control the stored overrides blob. Spy on
 * trackEvent to assert every 401/403 emits `system.capability_denied`.
 */

const mockGetUser = jest.fn();
const mockVerifyToken = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  DEFAULT_WORKSPACE_ID: "default",
}));

const mockCookieGet = jest.fn();
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: (...args: unknown[]) => mockCookieGet(...args) }),
}));

const mockLoadOverrides = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

jest.mock("../auth/capability-overrides", () => {
  const actual = jest.requireActual("../auth/capability-overrides");
  return {
    ...actual,
    loadUserOverrides: (...args: unknown[]) => mockLoadOverrides(...args),
  };
});

import {
  requireCapability,
  hasCapability,
  effectiveCapabilitiesFor,
} from "../auth/require-capability";

function mkReq(opts: { path?: string; auth?: string } = {}): Request {
  const url = `http://test${opts.path ?? "/api/clients"}`;
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  return new Request(url, { method: "GET", headers });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no overrides row (shadow mode falls back to role defaults).
  mockLoadOverrides.mockResolvedValue(null);
  // Default: no cookie present.
  mockCookieGet.mockReturnValue(undefined);
});

describe("requireCapability — anonymous", () => {
  it("returns 401 and emits capability_denied with role=anonymous", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await requireCapability(mkReq({ path: "/api/docs" }), "docs.view");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const body = await res.response.json();
      expect(body.error).toBe("unauthorized");
      expect(body.capability).toBe("docs.view");
    }
    expect(mockTrack).toHaveBeenCalledWith(
      "system.capability_denied",
      "anonymous",
      "anonymous",
      expect.objectContaining({
        capability: "docs.view",
        role: "anonymous",
        route: "/api/docs",
      }),
    );
  });
});

describe("requireCapability — insufficient caps", () => {
  it("returns 403 and emits capability_denied with user metadata", async () => {
    mockGetUser.mockReturnValue({ id: "u1", email: "s@x", name: "S", role: "sales", workspaceId: "default", created_at: "" });
    const res = await requireCapability(
      mkReq({ path: "/api/quickbooks", auth: "Bearer x" }),
      "finance.reports.view",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const body = await res.response.json();
      expect(body.error).toBe("forbidden");
      expect(body.capability).toBe("finance.reports.view");
    }
    expect(mockTrack).toHaveBeenCalledWith(
      "system.capability_denied",
      "u1",
      "sales",
      expect.objectContaining({
        capability: "finance.reports.view",
        role: "sales",
        user_id: "u1",
        route: "/api/quickbooks",
      }),
    );
  });
});

describe("requireCapability — authorized", () => {
  it("returns ok:true with user + capability set on success", async () => {
    mockGetUser.mockReturnValue({ id: "u2", email: "c@x", name: "C", role: "ceo", workspaceId: "default", created_at: "" });
    const res = await requireCapability(
      mkReq({ path: "/api/quickbooks", auth: "Bearer x" }),
      "finance.reports.view",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user.id).toBe("u2");
      expect(res.capabilities.has("finance.reports.view")).toBe(true);
    }
    // No denial event on success.
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("grants from overrides extend the role defaults", async () => {
    mockGetUser.mockReturnValue({ id: "u3", email: "s@x", name: "S", role: "sales", workspaceId: "default", created_at: "" });
    mockLoadOverrides.mockResolvedValue({
      role: "sales",
      overrides: { grants: ["finance.reports.view"], revokes: [], expires: {} },
    });
    const res = await requireCapability(
      mkReq({ path: "/api/quickbooks", auth: "Bearer x" }),
      "finance.reports.view",
    );
    expect(res.ok).toBe(true);
  });

  it("revokes in overrides deny a capability the role would grant", async () => {
    mockGetUser.mockReturnValue({ id: "u4", email: "d@x", name: "D", role: "dev", workspaceId: "default", created_at: "" });
    mockLoadOverrides.mockResolvedValue({
      role: "dev",
      overrides: { grants: [], revokes: ["docs.edit"], expires: {} },
    });
    const res = await requireCapability(
      mkReq({ path: "/api/docs/42", auth: "Bearer x" }),
      "docs.edit",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
  });
});

describe("routeOf normalization (via analytics metadata)", () => {
  it("collapses numeric id segments to :id", async () => {
    mockGetUser.mockReturnValue(null);
    await requireCapability(
      mkReq({ path: "/api/clients/12345" }),
      "clients.view",
    );
    const metadata = mockTrack.mock.calls[0][3];
    expect(metadata.route).toBe("/api/clients/:id");
  });
});

describe("hasCapability (sync)", () => {
  it("true when role has the cap", () => {
    expect(hasCapability({ role: "ceo" }, "finance.reports.view")).toBe(true);
  });
  it("false when role lacks the cap", () => {
    expect(hasCapability({ role: "sales" }, "finance.reports.view")).toBe(false);
  });
  it("false for null user", () => {
    expect(hasCapability(null, "docs.view")).toBe(false);
  });
  it("applies passed overrides", () => {
    const overrides = {
      grants: ["finance.reports.view" as const],
      revokes: [],
      expires: {},
    };
    expect(
      hasCapability({ role: "sales" }, "finance.reports.view", overrides),
    ).toBe(true);
  });
});

describe("effectiveCapabilitiesFor", () => {
  it("falls back to role defaults when no overrides row", async () => {
    mockLoadOverrides.mockResolvedValue(null);
    const user = { id: "u5", email: "x", name: "x", role: "sales" as const, workspaceId: "default", created_at: "" };
    const result = await effectiveCapabilitiesFor(user);
    expect(result.capabilities.has("clients.view")).toBe(true);
    expect(result.capabilities.has("finance.reports.view")).toBe(false);
  });
});

/* ---------------------------------------------------------------------
 * Regression 2026-05-15: browser-navigated admin routes (OAuth /start,
 * snapshot download links, etc.) only carry the access-token cookie —
 * not an Authorization header. requireCapability must resolve the user
 * from the cookie too, or the OAuth flow returns 401 on every kick-off.
 * --------------------------------------------------------------- */
describe("requireCapability — cookie fallback (browser-navigated routes)", () => {
  it("authorizes when Authorization header is missing but cookie carries a valid token", async () => {
    mockGetUser.mockReturnValue(null);
    mockCookieGet.mockReturnValue({ value: "VALID_JWT" });
    mockVerifyToken.mockReturnValue({
      userId: "u-cookie",
      email: "cto@wolfpack.dev",
      name: "Cookie CTO",
      role: "cto",
      workspaceId: "default",
    });
    const res = await requireCapability(
      mkReq({ path: "/api/admin/connectors/oauth/salesforce/start" }),
      "settings.manage_team",
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user.id).toBe("u-cookie");
      expect(res.user.role).toBe("cto");
    }
  });

  it("returns 401 when neither header nor cookie identifies a user", async () => {
    mockGetUser.mockReturnValue(null);
    mockCookieGet.mockReturnValue(undefined);
    const res = await requireCapability(
      mkReq({ path: "/api/admin/connectors/oauth/salesforce/start" }),
      "settings.manage_team",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });

  it("Authorization header takes precedence over cookie (header sets user, cookie unused)", async () => {
    mockGetUser.mockReturnValue({
      id: "u-header",
      email: "x",
      name: "x",
      role: "cto",
      workspaceId: "default",
      created_at: "",
    });
    /* Cookie also carries a token but should be ignored. */
    mockCookieGet.mockReturnValue({ value: "OTHER_JWT" });
    mockVerifyToken.mockImplementation(() => {
      throw new Error("verifyToken should not be reached when header is present");
    });
    const res = await requireCapability(
      mkReq({ path: "/api/clients", auth: "Bearer abc" }),
      "clients.view",
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.id).toBe("u-header");
  });

  it("falls back to 401 (not 500) when cookie's JWT fails verification", async () => {
    mockGetUser.mockReturnValue(null);
    mockCookieGet.mockReturnValue({ value: "TAMPERED_JWT" });
    mockVerifyToken.mockImplementation(() => {
      throw new Error("invalid signature");
    });
    const res = await requireCapability(
      mkReq({ path: "/api/admin/connectors/oauth/salesforce/start" }),
      "settings.manage_team",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(401);
  });
});
