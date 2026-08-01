/**
 * Contract for the acceptance endpoints: 200, 400 (by field), 401, 404.
 *
 * The 400 cases carry the weight. This route is the door that vague
 * requirements are supposed to be turned away at, so a test that only proved
 * the happy path would leave the door unlocked.
 */
import { NextRequest } from "next/server";

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
}));
jest.mock("@/lib/sites", () => ({
  getSiteProject: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn(async () => undefined),
  extractRequestMetadata: jest.fn(() => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "req-1" })),
}));
jest.mock("@/lib/site-acceptance/store", () => ({
  getAcceptanceCriteria: jest.fn(),
  saveAcceptanceCriteria: jest.fn(),
  listAcceptanceRuns: jest.fn(async () => []),
}));

import { GET, PUT } from "../route";
import { getUserFromRequest } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { getAcceptanceCriteria, saveAcceptanceCriteria, listAcceptanceRuns } from "@/lib/site-acceptance/store";

const USER = { id: "u1", role: "cto", workspaceId: "ws-1" };
const params = Promise.resolve({ id: "proj-1" });
const req = (body?: unknown) =>
  new NextRequest("http://localhost/api/sites/proj-1/acceptance", {
    method: body ? "PUT" : "GET",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  jest.clearAllMocks();
  (getUserFromRequest as jest.Mock).mockReturnValue(USER);
  (getSiteProject as jest.Mock).mockResolvedValue({ id: "proj-1" });
  (getAcceptanceCriteria as jest.Mock).mockResolvedValue(null);
  (listAcceptanceRuns as jest.Mock).mockResolvedValue([]);
  (saveAcceptanceCriteria as jest.Mock).mockImplementation(async (_ws, _id, criteria) => ({
    project_id: "proj-1",
    prototype_url: criteria.prototypeUrl,
    criteria,
    completeness: 0.6,
    updated_by: "u1",
    updated_at: "2026-08-01T00:00:00Z",
  }));
});

describe("GET /api/sites/[id]/acceptance", () => {
  it("401s without a session", async () => {
    (getUserFromRequest as jest.Mock).mockReturnValue(null);
    expect((await GET(req(), { params })).status).toBe(401);
  });

  it("404s for a project that does not exist", async () => {
    (getSiteProject as jest.Mock).mockResolvedValue(null);
    expect((await GET(req(), { params })).status).toBe(404);
  });

  it("returns the default contract and says it was never configured", async () => {
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    // An unconfigured project still reports a real gate rather than nothing,
    // and `configured` keeps that distinguishable from a deliberate default.
    expect(body.configured).toBe(false);
    expect(body.criteria.requiredRoutes).toEqual(["/"]);
    expect(body.runs).toEqual([]);
  });

  it("scopes both reads to the caller's workspace", async () => {
    await GET(req(), { params });
    expect(getAcceptanceCriteria).toHaveBeenCalledWith("ws-1", "proj-1");
    expect(listAcceptanceRuns).toHaveBeenCalledWith("ws-1", "proj-1", 25);
  });
});

describe("PUT /api/sites/[id]/acceptance", () => {
  it("401s without a session and 404s for an unknown project", async () => {
    (getUserFromRequest as jest.Mock).mockReturnValue(null);
    expect((await PUT(req({ criteria: {} }), { params })).status).toBe(401);

    (getUserFromRequest as jest.Mock).mockReturnValue(USER);
    (getSiteProject as jest.Mock).mockResolvedValue(null);
    expect((await PUT(req({ criteria: {} }), { params })).status).toBe(404);
  });

  it("stores a valid contract and reports how completely it was specified", async () => {
    const res = await PUT(
      req({ criteria: { prototypeUrl: "https://proto.test", requiredRoutes: ["/", "/about"], requiredContent: ["Acme"] } }),
      { params },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.criteria.requiredRoutes).toEqual(["/", "/about"]);
    expect(body.completeness).toBe(0.6);
    expect(saveAcceptanceCriteria).toHaveBeenCalledWith("ws-1", "proj-1", expect.objectContaining({ prototypeUrl: "https://proto.test/" }), "u1");
  });

  it("400s and names the offending field, so the message is actionable", async () => {
    const res = await PUT(req({ criteria: { tolerancePx: -3 } }), { params });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "tolerancePx" });
    expect(saveAcceptanceCriteria).not.toHaveBeenCalled();
  });

  it("400s on a route pinned to a host, which would let a check pass on the wrong site", async () => {
    const res = await PUT(req({ criteria: { requiredRoutes: ["https://elsewhere.test/"] } }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("requiredRoutes");
  });

  it("400s on a non-http prototype URL", async () => {
    const res = await PUT(req({ criteria: { prototypeUrl: "file:///etc/passwd" } }), { params });
    expect(res.status).toBe(400);
  });

  it("accepts the criteria at the top level as well as nested, so a plain form body works", async () => {
    const res = await PUT(req({ requiredContent: ["Acme"] }), { params });
    expect(res.status).toBe(200);
  });

  it("records the change to analytics and to the audit chain", async () => {
    await PUT(req({ criteria: { requiredContent: ["Acme"] } }), { params });
    expect(trackEvent).toHaveBeenCalledWith("site.acceptance_criteria_saved", "u1", "cto", expect.objectContaining({ project_id: "proj-1" }));
    // Widening a gate is a governance action; who did it must be answerable later.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "site.acceptance_criteria_saved", resourceId: "proj-1" }));
  });
});
