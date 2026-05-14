/**
 * /api/admin/connectors route tests — auth, validation, save flow,
 * audit-log integration, list flow.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));

const mockSave = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/assistant/connectors", () => ({
  saveConnectorCredentials: (...a: any[]) => mockSave(...a),
  listConnectorCredentials: (...a: any[]) => mockList(...a),
}));

const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockAudit(...a),
  extractRequestMetadata: () => ({
    ipAddress: "1.1.1.1",
    userAgent: "j",
    requestId: "r",
  }),
}));

import { GET, POST } from "@/app/api/admin/connectors/route";

const ADMIN = { id: "u1", email: "homyk@thewolfpack.agency", role: "cto", workspaceId: "default" };

function mkReq(body?: unknown): any {
  return {
    json: async () => body,
    headers: new Map(),
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/admin/connectors", () => {
  test("401 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: { status: 401 } as any,
    });
    const res = await GET(mkReq());
    expect((res as any).status).toBe(401);
  });

  test("200 with masked rows", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockList.mockResolvedValueOnce([
      {
        workspaceId: "default",
        connectorName: "rest-default",
        baseUrl: "https://api.acme.com",
        authHeaderHint: "Bearer ****1234",
        isActive: true,
        createdAt: "x",
        updatedAt: "y",
      },
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0].authHeaderHint).toBe("Bearer ****1234");
  });
});

describe("POST /api/admin/connectors", () => {
  test("401 when caller lacks settings.manage_team", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: { status: 401 } as any,
    });
    const res = await POST(mkReq({ connectorName: "rest-default" }));
    expect((res as any).status).toBe(401);
  });

  test("400 when connectorName is unsupported", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const res = await POST(
      mkReq({
        connectorName: "bogus",
        baseUrl: "https://x",
        authHeader: "Bearer abc",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when baseUrl is not http(s)", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const res = await POST(
      mkReq({
        connectorName: "rest-default",
        baseUrl: "ftp://x",
        authHeader: "Bearer abc",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when authHeader is missing / too short", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const res = await POST(
      mkReq({
        connectorName: "rest-default",
        baseUrl: "https://x",
        authHeader: "ab",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when objectMap entries aren't string→string", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    const res = await POST(
      mkReq({
        connectorName: "rest-default",
        baseUrl: "https://x",
        authHeader: "Bearer abcdef",
        objectMap: { deal: 99 },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("200 happy path: saves + audits", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockSave.mockResolvedValueOnce({
      workspaceId: "default",
      connectorName: "rest-default",
      baseUrl: "https://api.acme.com",
      authHeaderHint: "Bearer ****1234",
      isActive: true,
      createdAt: "x",
      updatedAt: "y",
    });
    const res = await POST(
      mkReq({
        connectorName: "rest-default",
        baseUrl: "https://api.acme.com",
        authHeader: "Bearer abc1234",
        objectMap: { deal: "opportunities" },
      }),
    );
    expect(res.status).toBe(200);

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        connectorName: "rest-default",
        baseUrl: "https://api.acme.com",
        authHeader: "Bearer abc1234",
        objectMap: { deal: "opportunities" },
        createdBy: "u1",
      }),
    );

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "connector.credentials.updated",
        resourceType: "connector_credentials",
        resourceId: "default:rest-default",
        afterState: expect.objectContaining({
          workspace_id: "default",
          connector_name: "rest-default",
          base_url: "https://api.acme.com",
          auth_header_hint: "Bearer ****1234",
          has_object_map: true,
        }),
      }),
    );
  });

  test("500 when save fails", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockSave.mockResolvedValueOnce(null);
    const res = await POST(
      mkReq({
        connectorName: "rest-default",
        baseUrl: "https://api.acme.com",
        authHeader: "Bearer abc1234",
      }),
    );
    expect(res.status).toBe(500);
  });

  test("workspaceId is NOT accepted from the body (prevents cross-tenant writes)", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ADMIN });
    mockSave.mockResolvedValueOnce({
      workspaceId: "default",
      connectorName: "rest-default",
      baseUrl: "https://x",
      authHeaderHint: "Bearer ****1234",
      isActive: true,
      createdAt: "x",
      updatedAt: "y",
    });
    await POST(
      mkReq({
        connectorName: "rest-default",
        baseUrl: "https://x",
        authHeader: "Bearer abc1234",
        workspaceId: "EVIL-OTHER-TENANT",
      } as any),
    );
    /* workspaceId in the call must be 'default', not the body value. */
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "default" }),
    );
  });
});

/* --- Multi-tenant isolation (migration 137) -------------------------
 *
 * With per-tenant credentials live, the route must read/write under the
 * caller's *own* workspace_id (taken from the JWT) and NEVER under a
 * workspace name from the request body. These tests cover both reads
 * and writes for two distinct tenants.
 */
describe("multi-tenant isolation", () => {
  const ACME_ADMIN = { id: "u-acme", email: "cto@acme", role: "cto", workspaceId: "ws_acme" };
  const BLITZ_ADMIN = { id: "u-blitz", email: "cto@blitz", role: "cto", workspaceId: "ws_blitz" };

  test("GET only returns the caller's own workspace creds", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ACME_ADMIN });
    mockList.mockResolvedValueOnce([
      { workspaceId: "ws_acme", connectorName: "hubspot", baseUrl: "https://api.hubapi.com", authHeaderHint: "Bearer ****ACME", isActive: true, createdAt: "x", updatedAt: "y" },
    ]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    /* listConnectorCredentials must be called with ACME's workspace,
       never "default" or a body value. */
    expect(mockList).toHaveBeenCalledWith("ws_acme");
  });

  test("POST writes under the caller's own workspace, ignoring body workspaceId", async () => {
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: BLITZ_ADMIN });
    mockSave.mockResolvedValueOnce({
      workspaceId: "ws_blitz",
      connectorName: "rest-default",
      baseUrl: "https://api.blitz.com",
      authHeaderHint: "Bearer ****BLITZ",
      isActive: true,
      createdAt: "x",
      updatedAt: "y",
    });
    await POST(
      mkReq({
        connectorName: "rest-default",
        baseUrl: "https://api.blitz.com",
        authHeader: "Bearer blitz-token-xyz",
        /* Attacker tries to write into Acme's workspace from Blitz's session: */
        workspaceId: "ws_acme",
      } as any),
    );
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_blitz",
        connectorName: "rest-default",
        createdBy: "u-blitz",
      }),
    );
    /* Audit log records the actual tenant, not the spoofed one. */
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "ws_blitz:rest-default",
        afterState: expect.objectContaining({ workspace_id: "ws_blitz" }),
      }),
    );
  });

  test("two callers in different workspaces never see each other's lists", async () => {
    /* Acme call returns Acme's row. */
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: ACME_ADMIN });
    mockList.mockResolvedValueOnce([
      { workspaceId: "ws_acme", connectorName: "hubspot", baseUrl: "https://api.hubapi.com", authHeaderHint: "Bearer ****ACME", isActive: true, createdAt: "x", updatedAt: "y" },
    ]);
    const r1 = await GET(mkReq());
    const b1 = await r1.json();

    /* Blitz call returns Blitz's row only. */
    mockRequireCapability.mockResolvedValueOnce({ ok: true, user: BLITZ_ADMIN });
    mockList.mockResolvedValueOnce([
      { workspaceId: "ws_blitz", connectorName: "salesforce", baseUrl: "https://blitz.my.salesforce.com", authHeaderHint: "Bearer ****BLITZ", isActive: true, createdAt: "x", updatedAt: "y" },
    ]);
    const r2 = await GET(mkReq());
    const b2 = await r2.json();

    expect(b1.connectors).toHaveLength(1);
    expect(b1.connectors[0].workspaceId).toBe("ws_acme");
    expect(b2.connectors).toHaveLength(1);
    expect(b2.connectors[0].workspaceId).toBe("ws_blitz");

    /* The store was queried per tenant; cross-talk would mean the
       same workspaceId appeared in both calls. */
    expect(mockList).toHaveBeenNthCalledWith(1, "ws_acme");
    expect(mockList).toHaveBeenNthCalledWith(2, "ws_blitz");
  });
});
