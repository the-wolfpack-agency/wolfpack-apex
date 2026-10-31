/** Contract: GET /api/admin/site-analytics/page-integrity is gated (analytics.view), needs a site, and returns the report. */
export {};
const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
const mockGet = jest.fn();
jest.mock("@/lib/forcefield/page-integrity", () => ({ getPageIntegrity: (...a: unknown[]) => mockGet(...a) }));
import { GET } from "@/app/api/admin/site-analytics/page-integrity/route";

const mkReq = (qs = ""): any => new Request(`http://test/api/admin/site-analytics/page-integrity${qs}`) as any;
const allowed = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["analytics.view"]) };
beforeEach(() => jest.clearAllMocks());

describe("GET /api/admin/site-analytics/page-integrity", () => {
  it.each([401, 403])("%s when the capability gate refuses, and nothing is read", async (status) => {
    mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status }) });
    expect((await GET(mkReq("?site=aidanmulready"))).status).toBe(status);
    expect(mockGet).not.toHaveBeenCalled();
  });
  it("400 without a valid site label", async () => {
    mockRequireCapability.mockResolvedValue(allowed);
    expect((await GET(mkReq())).status).toBe(400);
    expect((await GET(mkReq("?site=A%27%3B%20drop"))).status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
  it("200 with the site's report, scoped by label", async () => {
    mockRequireCapability.mockResolvedValue(allowed);
    mockGet.mockResolvedValue({ learning: null, origins: [], totals: { origins: 0, newOrigins: 0, wouldAlert: 0 } });
    const res = await GET(mkReq("?site=aidanmulready"));
    expect(res.status).toBe(200);
    expect((await res.json()).integrity.learning).toBeNull();
    expect(mockGet).toHaveBeenCalledWith("site:aidanmulready");
  });
});
