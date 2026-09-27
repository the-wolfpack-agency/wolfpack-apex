/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockFetchDashboard = jest.fn();
const mockFetchAttribution = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/ci-status", () => ({
  fetchCiDashboard: (...a: unknown[]) => mockFetchDashboard(...a),
  fetchCiAttribution: (...a: unknown[]) => mockFetchAttribution(...a),
}));

import { GET } from "../route";
const req = (qs: string) => new NextRequest(`http://localhost/api/admin/ai-code/ci?${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockFetchDashboard.mockResolvedValue({ categories: [{ key: "unit", label: "Unit tests", status: "pass", passed: 1, failed: 0, pending: 0, checks: ["unit"] }], overall: "pass", summary: { total: 1, passed: 1, failed: 0, pending: 0 } });
  mockFetchAttribution.mockResolvedValue({ introduced: [], preexisting: ["e2e"], indeterminate: [], fixed: [], baselineKnown: true, baselineHealthy: false, clean: true, reason: "This change introduced no new failures. 1 were already failing on the base branch." });
});

it("401 unauth / 403 unentitled", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req("repo=o/r&ref=main"))).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(req("repo=o/r&ref=main"))).status).toBe(403);
});

it("400 on missing or malformed repo/ref", async () => {
  expect((await GET(req("repo=o/r"))).status).toBe(400);
  expect((await GET(req("repo=bad&ref=main"))).status).toBe(400);
});

it("returns the checkpoint dashboard, workspace-scoped", async () => {
  const res = await GET(req("repo=o/r&ref=main"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(mockFetchDashboard).toHaveBeenCalledWith("o/r", "main", "w1");
  expect(body.dashboard.overall).toBe("pass");
  expect(body.dashboard.categories[0].label).toBe("Unit tests");
});

it("does NOT attribute without a base branch (attribution null)", async () => {
  const body = await (await GET(req("repo=o/r&ref=feature"))).json();
  expect(mockFetchAttribution).not.toHaveBeenCalled();
  expect(body.attribution).toBeNull();
});

it("attributes the delta against the base branch when base is provided", async () => {
  const body = await (await GET(req("repo=o/r&ref=factory/x&base=main"))).json();
  expect(mockFetchAttribution).toHaveBeenCalledWith("o/r", "main", "factory/x", "w1");
  expect(body.attribution.introduced).toEqual([]);
  expect(body.attribution.preexisting).toEqual(["e2e"]);
  expect(body.attribution.clean).toBe(true);
});
