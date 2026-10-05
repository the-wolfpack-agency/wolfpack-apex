/** @jest-environment node */
/**
 * GET /api/admin/ai-code/pulls contract: auth (401) + entitlement (403) + missing
 * repo (400) + the happy path returns the workspace-scoped factory PR statuses.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockGate = jest.fn();
const mockClient = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/github-client", () => ({ workspaceGithubClient: (...a: unknown[]) => mockClient(...a) }));
jest.mock("@/lib/ai-code/pull-approvals", () => ({ listFactoryPullStatuses: (...a: unknown[]) => mockList(...a) }));

import { GET } from "../route";
const req = (repo = "o/r") => new NextRequest(`http://localhost/api/admin/ai-code/pulls?repo=${encodeURIComponent(repo)}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockCap.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockClient.mockResolvedValue({ token: "t", fetch: jest.fn() });
  mockList.mockResolvedValue([{ number: 5, eligible: true, ciGreen: true }]);
});

it("401 unauth", async () => {
  mockCap.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req())).status).toBe(401);
});

it("403 unentitled", async () => {
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(req())).status).toBe(403);
});

it("400 when repo missing", async () => {
  const res = await GET(new NextRequest("http://localhost/api/admin/ai-code/pulls"));
  expect(res.status).toBe(400);
});

it("200 returns workspace-scoped pulls", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.pulls).toHaveLength(1);
  expect(mockList).toHaveBeenCalledWith(expect.anything(), "o/r", "w1");
});

it("no GitHub credential -> 200 with empty list + note (never 500)", async () => {
  mockClient.mockResolvedValue({ token: "", fetch: jest.fn() });
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.pulls).toEqual([]);
  expect(body.note).toMatch(/credential/i);
});
