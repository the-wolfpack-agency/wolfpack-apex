/**
 * Contract: GET /api/admin/site-analytics is capability-gated (analytics.view)
 * and returns the aggregated summary. The lib is mocked.
 */
export {};

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockGetSummary = jest.fn();
jest.mock("@/lib/site-analytics", () => ({
  getSiteAnalyticsSummary: (...a: unknown[]) => mockGetSummary(...a),
}));

import { GET } from "@/app/api/admin/site-analytics/route";

function mkReq(qs = ""): any {
  return new Request(`http://test/api/admin/site-analytics${qs}`, { method: "GET" }) as any;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/admin/site-analytics", () => {
  it("403 when the capability gate denies", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    mockRequireCapability.mockResolvedValue({ ok: false, response: denied });
    const res = await GET(mkReq());
    expect(res.status).toBe(403);
    expect(mockGetSummary).not.toHaveBeenCalled();
  });

  it("200 with the summary, honoring the days param", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "cto" } });
    mockGetSummary.mockResolvedValue({ rangeDays: 7, totalPageViews: 5, totalEvents: 9, byHour: [], byPage: [], byCountry: [], byType: [] });
    const res = await GET(mkReq("?days=7"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.rangeDays).toBe(7);
    expect(mockGetSummary).toHaveBeenCalledWith(7);
  });
});
