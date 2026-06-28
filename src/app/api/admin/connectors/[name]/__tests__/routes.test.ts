/**
 * Tests for /api/admin/connectors/[name]/{disconnect,verify} routes.
 */

const mockRequireCapability = jest.fn();
const mockSafeQuery = jest.fn();
const mockBuildRest = jest.fn();
const mockTrackEvent = jest.fn();
const mockAudit = jest.fn().mockResolvedValue(undefined);

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  query: jest.fn(),
}));
jest.mock("@/lib/assistant/connectors", () => ({
  buildRestConnectorForWorkspace: (...a: any[]) => mockBuildRest(...a),
}));
const mockLoadCreds = jest.fn().mockResolvedValue(null);
jest.mock("@/lib/assistant/connectors/credentials", () => ({
  loadConnectorCredentials: (...a: any[]) => mockLoadCreds(...a),
}));
const mockEstablishSession = jest.fn();
const mockEstablishOAuth = jest.fn();
jest.mock("@/lib/platform-scan/session", () => ({
  establishSession: (...a: any[]) => mockEstablishSession(...a),
  establishOAuthPasswordSession: (...a: any[]) => mockEstablishOAuth(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "j", requestId: "r" }),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST as disconnectPOST } from "@/app/api/admin/connectors/[name]/disconnect/route";
import { POST as verifyPOST } from "@/app/api/admin/connectors/[name]/verify/route";

function req(): NextRequest {
  return new NextRequest("http://x/api/admin/connectors/salesforce/disconnect", {
    method: "POST",
  });
}

const ADMIN = {
  ok: true as const,
  user: { id: "u-cto", role: "cto" as const, workspaceId: "ws1" },
  capabilities: new Set<any>(),
};
const UNAUTH = { ok: false as const, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/admin/connectors/[name]/disconnect", () => {
  test("401 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValueOnce(UNAUTH);
    const res = await disconnectPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(401);
  });

  test("happy path: flips is_active=false, audits, fires analytics", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    const res = await disconnectPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(200);

    /* SQL was an UPDATE with workspace + connector params. */
    const sql = mockSafeQuery.mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE instinct_connector_credentials");
    expect(sql).toContain("is_active = FALSE");
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws1", "salesforce"]);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_disconnected",
      "u-cto",
      "cto",
      expect.objectContaining({ connector: "salesforce", workspace_id: "ws1" }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "connector.credentials.disconnected",
        resourceId: "ws1:salesforce",
      }),
    );
  });

  test("404 when no active row matches", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    const res = await disconnectPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(404);
  });

  test("500 + analytics on DB error", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    mockSafeQuery.mockRejectedValueOnce(new Error("conn refused"));
    const res = await disconnectPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(500);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_disconnect_failed",
      "u-cto",
      "cto",
      expect.objectContaining({ reason: "conn refused" }),
    );
  });

  test("workspace comes from session, not the body (cross-tenant protection)", async () => {
    /* Even though the URL param identifies the connector, the workspace
       MUST come from auth.user.workspaceId — a privileged user in
       workspace A cannot disconnect workspace B's connector. */
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { id: "u-evil", role: "cto", workspaceId: "ws_acme" },
      capabilities: new Set(),
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    await disconnectPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    /* SQL was called with the session's workspaceId, not anything from the URL. */
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws_acme", "salesforce"]);
  });
});

describe("POST /api/admin/connectors/[name]/verify", () => {
  test("401 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValueOnce(UNAUTH);
    const res = await verifyPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(401);
  });

  test("404 when connector isn't configured", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => false,
      searchRecords: jest.fn(),
    });
    const res = await verifyPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(404);
  });

  test("happy path: searchRecords returns ok → 200 with duration", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    const mockSearch = jest.fn().mockResolvedValueOnce({ ok: true, data: [], durationMs: 42 });
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: mockSearch,
    });
    const res = await verifyPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.duration_ms).toBe("number");
    /* Probe was a 2-char query against contact, limit 1. */
    expect(mockSearch).toHaveBeenCalledWith("contact", "xx", 1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_verified",
      "u-cto",
      "cto",
      expect.objectContaining({ connector: "salesforce", ok: true }),
    );
  });

  test("401 from SF (auth_failed) maps to 401 with code=auth_failed", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: jest.fn().mockResolvedValueOnce({
        ok: false,
        code: "auth_failed",
        message: "HTTP 401",
        durationMs: 5,
      }),
    });
    const res = await verifyPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth_failed");
  });

  test("remote 500 maps to 502 (bad gateway — upstream vendor failed)", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: jest.fn().mockResolvedValueOnce({
        ok: false,
        code: "remote_error",
        message: "HTTP 500",
        durationMs: 5,
      }),
    });
    const res = await verifyPOST(req(), { params: Promise.resolve({ name: "salesforce" }) });
    expect(res.status).toBe(502);
  });

  test("username_password connector: verifies by FORM LOGIN, not a REST probe (200 on success)", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    mockLoadCreds.mockResolvedValueOnce({
      authType: "username_password",
      baseUrl: "https://beyond-sku.vercel.app",
      loginPath: "/api/auth/login",
      sessionCookieName: "session",
      username: "admin@acme.com",
      password: "s3cret",
    });
    mockEstablishSession.mockResolvedValueOnce({ cookie: "session=abc" });
    const res = await verifyPOST(req(), { params: Promise.resolve({ name: "wolfpack-beyond" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // It logged in; it did NOT fall through to the REST search probe.
    expect(mockEstablishSession).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://beyond-sku.vercel.app", loginPath: "/api/auth/login" }),
    );
    expect(mockBuildRest).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_verified", "u-cto", "cto",
      expect.objectContaining({ connector: "wolfpack-beyond", ok: true }),
    );
  });

  test("username_password connector: failed login maps to 401 auth_failed (no REST fallback)", async () => {
    mockRequireCapability.mockResolvedValueOnce(ADMIN);
    mockLoadCreds.mockResolvedValueOnce({
      authType: "username_password",
      baseUrl: "https://beyond-sku.vercel.app",
      loginPath: "/api/auth/login",
      sessionCookieName: "session",
      username: "admin@acme.com",
      password: "wrong",
    });
    mockEstablishSession.mockResolvedValueOnce(null);
    const res = await verifyPOST(req(), { params: Promise.resolve({ name: "wolfpack-beyond" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth_failed");
    expect(mockBuildRest).not.toHaveBeenCalled();
  });
});
