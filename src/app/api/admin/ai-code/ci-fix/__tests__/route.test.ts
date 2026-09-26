/** @jest-environment node */
const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockFetchCiStatus = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/ci-status", () => ({ fetchCiStatus: (...a: unknown[]) => mockFetchCiStatus(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ai-code/ci-fix", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const green = { total: 2, passed: 2, failed: 0, pending: 0, complete: true, ciComplete: true, failedChecks: [], failedDetails: [] };
const red = { total: 2, passed: 1, failed: 1, pending: 0, complete: true, ciComplete: false, failedChecks: ["unit"], failedDetails: [{ name: "unit", summary: "a test failed" }] };

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue(OK);
  mockGate.mockResolvedValue(null);
});

test("401 / 403 / 400 guards", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await POST(post({ repo: "o/r", ref: "b" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValue(OK);
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await POST(post({ repo: "o/r", ref: "b" }))).status).toBe(403);
  mockGate.mockResolvedValue(null);
  expect((await POST(post({ repo: "o/r" }))).status).toBe(400);
});

test("green CI -> merge_ready, no brief", async () => {
  mockFetchCiStatus.mockResolvedValue(green);
  const body = await (await POST(post({ repo: "o/r", ref: "b" }))).json();
  expect(body.decision.action).toBe("merge_ready");
  expect(body.brief).toBeUndefined();
});

test("red CI with budget -> author_fix + a fix brief", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  const body = await (await POST(post({ repo: "o/r", ref: "b", attempt: 0, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("author_fix");
  expect(body.brief).toMatch(/unit.*a test failed/);
});

test("red CI out of budget -> escalate_human", async () => {
  mockFetchCiStatus.mockResolvedValue(red);
  const body = await (await POST(post({ repo: "o/r", ref: "b", attempt: 3, maxAttempts: 3 }))).json();
  expect(body.decision.action).toBe("escalate_human");
});
