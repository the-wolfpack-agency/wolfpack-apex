const mockList = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/templates/registry", () => ({
  listIntegrationTemplates: (...a: unknown[]) => mockList(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));

const CTO = { id: "u1", role: "cto", name: "N", email: "n@x.co" };
let user: { id: string; role: string; name: string; email: string } | null = CTO;
jest.mock("@/lib/auth", () => ({ getUserFromRequest: () => user }));

import { NextRequest } from "next/server";
import { GET } from "../route";

const REQ = (qs = "") =>
  new NextRequest(`https://x.test/api/admin/templates${qs}`, {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });

beforeEach(() => {
  mockList.mockReset();
  mockTrack.mockReset();
  user = CTO;
});

describe("GET /api/admin/templates", () => {
  test("401 when unauthenticated", async () => {
    user = null;
    const r = await GET(REQ());
    expect(r.status).toBe(401);
  });

  test("403 when role is not cto/ceo/evp", async () => {
    user = { id: "u2", role: "dev", name: "D", email: "d@x.co" };
    const r = await GET(REQ());
    expect(r.status).toBe(403);
  });

  test("returns templates + fires audit-log event", async () => {
    mockList.mockResolvedValue([
      { templateId: "calendar_widget", vendor: "microsoft", surface: "widget", useCases: [] },
    ]);
    const r = await GET(REQ());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.templates[0].templateId).toBe("calendar_widget");
    expect(mockTrack).toHaveBeenCalledWith(
      "system.audit_log_viewed",
      "u1",
      "cto",
      expect.objectContaining({ view: "templates.registry" }),
    );
  });

  test("vendor + surface filter forwarded to lib", async () => {
    mockList.mockResolvedValue([]);
    await GET(REQ("?vendor=salesforce&surface=form"));
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: "salesforce", surface: "form", activeOnly: true }),
    );
  });

  test("?includeRetired=true sets activeOnly=false", async () => {
    mockList.mockResolvedValue([]);
    await GET(REQ("?includeRetired=true"));
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ activeOnly: false }),
    );
  });

  test("invalid surface is dropped (not passed to lib)", async () => {
    mockList.mockResolvedValue([]);
    await GET(REQ("?surface=garbage"));
    const call = mockList.mock.calls[0][0];
    expect(call.surface).toBeUndefined();
  });
});
