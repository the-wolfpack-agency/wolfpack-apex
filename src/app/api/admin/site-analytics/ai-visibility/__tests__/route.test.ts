/** Contract: GET /api/admin/site-analytics/ai-visibility is gated (analytics.view), needs a site, and returns the report. */
export {};
const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
const mockGet = jest.fn();
jest.mock("@/lib/forcefield-web/ai-visibility", () => ({ getAiVisibility: (...a: unknown[]) => mockGet(...a) }));
import { GET } from "@/app/api/admin/site-analytics/ai-visibility/route";

const mkReq = (qs = ""): any => new Request(`http://test/api/admin/site-analytics/ai-visibility${qs}`) as any;
const allowed = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["analytics.view"]) };
beforeEach(() => jest.clearAllMocks());

describe("GET /api/admin/site-analytics/ai-visibility", () => {
  it.each([401, 403])("%s when the capability gate refuses, and nothing is read", async (status) => {
    mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status }) });
    expect((await GET(mkReq("?site=weekendwithporsche"))).status).toBe(status);
    expect(mockGet).not.toHaveBeenCalled();
  });
  it("400 without a valid site label", async () => {
    mockRequireCapability.mockResolvedValue(allowed);
    expect((await GET(mkReq())).status).toBe(400);
    expect((await GET(mkReq("?site=a%27%3B%20drop"))).status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
  it("200 with the site's report, scoped by label, honoring days", async () => {
    mockRequireCapability.mockResolvedValue(allowed);
    mockGet.mockResolvedValue({ sinceIso: "x", days: 7, byPurpose: {}, agents: [{ agent: "ClaudeBot" }] });
    const res = await GET(mkReq("?site=weekendwithporsche&days=7"));
    expect(res.status).toBe(200);
    expect((await res.json()).visibility.agents[0].agent).toBe("ClaudeBot");
    expect(mockGet).toHaveBeenCalledWith({ site: "weekendwithporsche" }, { days: 7 });
  });
});
