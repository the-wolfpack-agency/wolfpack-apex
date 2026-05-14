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

const ADMIN = { id: "u1", email: "homyk@thewolfpack.agency", role: "cto" };

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
