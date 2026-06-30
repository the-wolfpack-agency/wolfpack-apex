/**
 * Contract tests for /api/admin/compliance/report (POST generate + GET history).
 * Auth (401/403), framework validation (400), the report passthrough scoped to
 * the workspace, and the analytics (report_generated + a gap event per gap
 * control). The orchestrate + store libs are mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockRun = jest.fn();
const mockList = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/compliance/orchestrate", () => ({ runComplianceReport: (...a: unknown[]) => mockRun(...a) }));
jest.mock("@/lib/compliance/store", () => ({ listReports: (...a: unknown[]) => mockList(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "../route";

const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });
const req = (m: string, body?: unknown) =>
  new NextRequest("https://x.test/api/admin/compliance/report", {
    method: m,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  jest.resetAllMocks();
  mockList.mockResolvedValue([]);
  mockRun.mockResolvedValue({
    report: {
      framework: "EU_AI_ACT",
      controls: [
        { id: "EUAIACT-ART12", status: "gap" },
        { id: "EUAIACT-ART14", status: "covered" },
      ],
      covered: 3,
      partial: 0,
      gap: 1,
      coverage: 0.75,
    },
    id: "cmp_x",
  });
});

test("GET 401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req("GET"))).status).toBe(401);
});

test("POST 403 when lacking capability", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await POST(req("POST", { framework: "SOC2" }))).status).toBe(403);
});

test("POST 400 on a missing/invalid framework", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  expect((await POST(req("POST", {}))).status).toBe(400);
  expect((await POST(req("POST", { framework: "HIPAA" }))).status).toBe(400);
  expect(mockRun).not.toHaveBeenCalled();
});

test("POST generates the report scoped to the workspace and emits analytics + a gap event", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await POST(req("POST", { framework: "EU_AI_ACT" }));
  expect(res.status).toBe(200);
  expect((await res.json()).report.coverage).toBe(0.75);
  expect(mockRun).toHaveBeenCalledWith("w-1", "EU_AI_ACT", expect.any(String));
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "compliance.report_generated",
    "u-1",
    "cto",
    expect.objectContaining({ framework: "EU_AI_ACT", coverage: 0.75, gap: 1 }),
  );
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "compliance.gap_detected",
    "u-1",
    "cto",
    { framework: "EU_AI_ACT", control_id: "EUAIACT-ART12" },
  );
});

test("GET returns the report history", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockList.mockResolvedValue([{ id: "cmp_x", framework: "SOC2", coverage: 1, covered: 4, partial: 0, gap: 0, createdAt: "t" }]);
  expect((await (await GET(req("GET"))).json()).reports).toHaveLength(1);
  expect(mockList).toHaveBeenCalledWith("w-1");
});
