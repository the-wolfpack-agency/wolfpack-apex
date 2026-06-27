/**
 * /api/admin/connectors/github-app route tests - auth (401/403), validation
 * (400), status (GET), link (POST), unlink (DELETE), audit integration, and
 * that workspaceId always comes from the session, never the body.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockLink = jest.fn();
const mockRemove = jest.fn();
const mockGet = jest.fn();
const mockReadAppConfig = jest.fn();
jest.mock("@/lib/github-app", () => ({
  linkInstallation: (...a: unknown[]) => mockLink(...a),
  removeInstallation: (...a: unknown[]) => mockRemove(...a),
  getInstallation: (...a: unknown[]) => mockGet(...a),
  readAppConfigFromEnv: (...a: unknown[]) => mockReadAppConfig(...a),
}));

const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "j", requestId: "r" }),
}));

import { GET, POST, DELETE } from "@/app/api/admin/connectors/github-app/route";

const ADMIN = { id: "u1", email: "cto@wolf", role: "cto", workspaceId: "default" };

function mkReq(body?: unknown): any {
  return { json: async () => body, headers: new Map() } as any;
}

const origPat = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = "pat-xxx";
});
afterEach(() => {
  if (origPat === undefined) delete process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
  else process.env.GITHUB_TOKEN_WOLFPACK_AGENCY = origPat;
});

describe("GET status", () => {
  it("401 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: false, response: { status: 401 } as any });
    const res = await GET(mkReq());
    expect((res as any).status).toBe(401);
  });

  it("200 with fallback=installation when configured + linked", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockReadAppConfig.mockReturnValueOnce({ appId: "9", privateKeyPem: "pem" });
    mockGet.mockResolvedValueOnce({
      workspaceId: "default",
      installationId: "42",
      accountLogin: "acme",
      linkedAt: "x",
      linkedBy: "u1",
    });
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.fallback).toBe("installation");
    expect(body.installation.installationId).toBe("42");
    expect(mockGet).toHaveBeenCalledWith("default");
  });

  it("200 with fallback=pat when configured but not linked", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockReadAppConfig.mockReturnValueOnce({ appId: "9", privateKeyPem: "pem" });
    mockGet.mockResolvedValueOnce(null);
    const res = await GET(mkReq());
    const body = await res.json();
    expect(body.fallback).toBe("pat");
    expect(body.installation).toBeNull();
  });

  it("200 with fallback=none when neither App nor PAT configured", async () => {
    delete process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockReadAppConfig.mockReturnValueOnce(null);
    mockGet.mockResolvedValueOnce(null);
    const res = await GET(mkReq());
    const body = await res.json();
    expect(body.fallback).toBe("none");
    expect(body.configured).toBe(false);
  });
});

describe("POST link", () => {
  it("401 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: false, response: { status: 401 } as any });
    const res = await POST(mkReq({ installationId: "42" }));
    expect((res as any).status).toBe(401);
  });

  it("400 when installationId is not numeric", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const res = await POST(mkReq({ installationId: "not-a-number" }));
    expect(res.status).toBe(400);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("400 when accountLogin is not a string", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const res = await POST(mkReq({ installationId: "42", accountLogin: 99 }));
    expect(res.status).toBe(400);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("200 happy path: links + audits", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockLink.mockResolvedValueOnce({
      workspaceId: "default",
      installationId: "42",
      accountLogin: "acme",
      linkedAt: "x",
      linkedBy: "u1",
    });
    const res = await POST(mkReq({ installationId: "42", accountLogin: "acme" }));
    expect(res.status).toBe(200);
    expect(mockLink).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        installationId: "42",
        accountLogin: "acme",
        linkedBy: "u1",
      }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "connector.github_app.linked",
        resourceType: "github_app_installation",
        resourceId: "default:42",
      }),
    );
  });

  it("workspaceId is taken from the session, never the body", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { ...ADMIN, workspaceId: "ws_blitz" },
    });
    mockLink.mockResolvedValueOnce({
      workspaceId: "ws_blitz",
      installationId: "42",
      accountLogin: null,
      linkedAt: "x",
      linkedBy: "u1",
    });
    await POST(mkReq({ installationId: "42", workspaceId: "ws_acme" } as any));
    expect(mockLink).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_blitz" }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "ws_blitz:42" }),
    );
  });
});

describe("DELETE unlink", () => {
  it("403 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: false, response: { status: 403 } as any });
    const res = await DELETE(mkReq());
    expect((res as any).status).toBe(403);
  });

  it("200 + removed=true + audits when an installation existed", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockRemove.mockResolvedValueOnce(true);
    const res = await DELETE(mkReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(true);
    expect(mockRemove).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "default", removedBy: "u1" }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "connector.github_app.removed" }),
    );
  });

  it("200 + removed=false when nothing was linked (idempotent)", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockRemove.mockResolvedValueOnce(false);
    const res = await DELETE(mkReq());
    const body = await res.json();
    expect(body.removed).toBe(false);
  });
});
