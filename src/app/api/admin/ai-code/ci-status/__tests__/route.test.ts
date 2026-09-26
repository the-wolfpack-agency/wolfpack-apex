/** @jest-environment node */
const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockFetchCiStatus = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/ci-status", () => ({ fetchCiStatus: (...a: unknown[]) => mockFetchCiStatus(...a) }));

import { NextRequest } from "next/server";
import { GET } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const req = (qs: string) => new NextRequest(`http://localhost/api/admin/ai-code/ci-status${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK);
  mockGate.mockResolvedValue(null);
  mockFetchCiStatus.mockResolvedValue({ total: 3, passed: 3, failed: 0, pending: 0, complete: true, ciComplete: true, failedChecks: [] });
});

test("401 without a session", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req("?repo=o/r&ref=b"))).status).toBe(401);
});
test("403 without the secure_agent entitlement", async () => {
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(req("?repo=o/r&ref=b"))).status).toBe(403);
});
test("400 when repo or ref is missing", async () => {
  expect((await GET(req("?repo=o/r"))).status).toBe(400);
  expect((await GET(req("?ref=b"))).status).toBe(400);
});
test("200 returns the CI summary and passes workspace scope through", async () => {
  const res = await GET(req("?repo=o/r&ref=factory/x-abc123"));
  expect(res.status).toBe(200);
  expect((await res.json()).summary.ciComplete).toBe(true);
  expect(mockFetchCiStatus).toHaveBeenCalledWith("o/r", "factory/x-abc123", "w1");
});
