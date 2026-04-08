/**
 * /api/sites route tests — auth gate, validation surface, webhook secret.
 */

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
}));

const mockCreate = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockDeploy = jest.fn();
const mockRecordResult = jest.fn();
class FakeBriefError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super("brief invalid: " + errors.join(", "));
    this.name = "BriefValidationError";
    this.errors = errors;
  }
}
jest.mock("@/lib/sites", () => ({
  createSiteProject: (...args: unknown[]) => mockCreate(...args),
  listSiteProjects: (...args: unknown[]) => mockList(...args),
  getSiteProject: (...args: unknown[]) => mockGet(...args),
  updateBrief: (...args: unknown[]) => mockUpdate(...args),
  triggerDeploy: (...args: unknown[]) => mockDeploy(...args),
  recordDeployResult: (...args: unknown[]) => mockRecordResult(...args),
  BriefValidationError: FakeBriefError,
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import { GET as listGET, POST as listPOST } from "@/app/api/sites/route";
import { PATCH as detailPATCH, GET as detailGET } from "@/app/api/sites/[id]/route";
import { POST as webhookPOST } from "@/app/api/sites/webhook/route";

function mkReq(opts: { auth?: string; body?: unknown; url?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers(opts.headers ?? {});
  if (opts.auth) headers.set("authorization", opts.auth);
  return new Request(opts.url ?? "http://test/api/sites", {
    method: opts.body ? "POST" : "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }) as unknown as import("next/server").NextRequest;
}

describe("/api/sites GET + POST", () => {
  beforeEach(() => jest.clearAllMocks());

  it("GET returns 401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await listGET(mkReq());
    expect(res.status).toBe(401);
  });

  it("GET returns projects list when authed", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockList.mockResolvedValue([{ id: "site_1" }]);
    const res = await listGET(mkReq({ auth: "Bearer x" }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.projects).toHaveLength(1);
  });

  it("POST 401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await listPOST(mkReq({ body: { brief: {} } }));
    expect(res.status).toBe(401);
  });

  it("POST 400 when brief missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    const res = await listPOST(mkReq({ auth: "Bearer x", body: {} }));
    expect(res.status).toBe(400);
  });

  it("POST 422 surfaces validation errors", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockCreate.mockRejectedValueOnce(new FakeBriefError(["client must be a slug"]));
    const res = await listPOST(mkReq({ auth: "Bearer x", body: { brief: { foo: 1 } } }));
    const data = await res.json();
    expect(res.status).toBe(422);
    expect(data.errors).toContain("client must be a slug");
  });

  it("POST 201 returns the created project", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockCreate.mockResolvedValueOnce({ id: "site_1" });
    const res = await listPOST(mkReq({ auth: "Bearer x", body: { brief: { client: "x" } } }));
    expect(res.status).toBe(201);
  });
});

describe("/api/sites/[id]", () => {
  beforeEach(() => jest.clearAllMocks());

  it("GET 404 when project missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockGet.mockResolvedValueOnce(null);
    const res = await detailGET(mkReq({ auth: "Bearer x" }), { params: Promise.resolve({ id: "site_x" }) });
    expect(res.status).toBe(404);
  });

  it("PATCH ?action=deploy invokes triggerDeploy", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockDeploy.mockResolvedValueOnce({ deployId: "deploy_1", workflowRun: null });
    const req = new NextRequest("http://test/api/sites/site_1?action=deploy", {
      method: "PATCH",
      headers: { authorization: "Bearer x" },
    });
    const res = await detailPATCH(req, { params: Promise.resolve({ id: "site_1" }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.deployId).toBe("deploy_1");
    expect(mockDeploy).toHaveBeenCalledWith("site_1", "u_1", "sales");
  });

  it("PATCH (no action) updates brief", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockUpdate.mockResolvedValueOnce({ id: "site_1" });
    const req = new NextRequest("http://test/api/sites/site_1", {
      method: "PATCH",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ brief: { client: "x" } }),
    });
    const res = await detailPATCH(req, { params: Promise.resolve({ id: "site_1" }) });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });
});

describe("/api/sites/webhook", () => {
  const ORIGINAL = process.env.WOLFPACK_SITES_WEBHOOK_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WOLFPACK_SITES_WEBHOOK_SECRET = "shh";
  });
  afterAll(() => {
    process.env.WOLFPACK_SITES_WEBHOOK_SECRET = ORIGINAL;
  });

  it("403 without secret header", async () => {
    const req = new Request("http://test/api/sites/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deployId: "d1", status: "success" }),
    }) as unknown as import("next/server").NextRequest;
    const res = await webhookPOST(req);
    expect(res.status).toBe(403);
    expect(mockRecordResult).not.toHaveBeenCalled();
  });

  it("403 with wrong secret", async () => {
    const req = new Request("http://test/api/sites/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wolfpack-webhook-secret": "wrong" },
      body: JSON.stringify({ deployId: "d1", status: "success" }),
    }) as unknown as import("next/server").NextRequest;
    expect((await webhookPOST(req)).status).toBe(403);
  });

  it("403 when env var unset (closed by default)", async () => {
    delete process.env.WOLFPACK_SITES_WEBHOOK_SECRET;
    const req = new Request("http://test/api/sites/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wolfpack-webhook-secret": "anything" },
      body: JSON.stringify({ deployId: "d1", status: "success" }),
    }) as unknown as import("next/server").NextRequest;
    expect((await webhookPOST(req)).status).toBe(403);
  });

  it("400 with missing deployId or bad status", async () => {
    const req = new Request("http://test/api/sites/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wolfpack-webhook-secret": "shh" },
      body: JSON.stringify({ status: "wat" }),
    }) as unknown as import("next/server").NextRequest;
    expect((await webhookPOST(req)).status).toBe(400);
  });

  it("200 invokes recordDeployResult when authorized", async () => {
    mockRecordResult.mockResolvedValueOnce(undefined);
    const req = new Request("http://test/api/sites/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wolfpack-webhook-secret": "shh" },
      body: JSON.stringify({
        deployId: "d1",
        status: "success",
        previewUrl: "https://x.vercel.app",
        canaryPassed: true,
      }),
    }) as unknown as import("next/server").NextRequest;
    const res = await webhookPOST(req);
    expect(res.status).toBe(200);
    expect(mockRecordResult).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "success", canaryPassed: true }),
    );
  });
});
