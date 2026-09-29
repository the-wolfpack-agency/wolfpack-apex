/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockEstablish = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/ci-status", () => ({ establishBaseline: (...a: unknown[]) => mockEstablish(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST } from "../route";
const req = (body: unknown) => new NextRequest("http://localhost/api/admin/ai-code/baseline", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockEstablish.mockResolvedValue({ dispatched: true, runId: "7", workflowFile: "factory-validate.yml" });
});

it("401 unauth / 403 unentitled", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await POST(req({ repo: "o/r", base: "main" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await POST(req({ repo: "o/r", base: "main" }))).status).toBe(403);
});

it("400 on malformed repo or missing base", async () => {
  expect((await POST(req({ repo: "not a repo", base: "main" }))).status).toBe(400);
  expect((await POST(req({ repo: "o/r" }))).status).toBe(400);
});

it("dispatches the baseline, workspace-scoped, and records the event", async () => {
  const res = await POST(req({ repo: "o/r", base: "main" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.dispatched).toBe(true);
  expect(mockEstablish).toHaveBeenCalledWith("o/r", "main", { workflowFile: undefined, workspaceId: "w1" });
  expect(mockTrack).toHaveBeenCalledWith("ai_code.baseline_established", "u1", "admin", { repo: "o/r", workflow: "factory-validate.yml", dispatched: true });
});

it("passes a caller-specified workflow through", async () => {
  await POST(req({ repo: "o/r", base: "develop", workflow: "ci.yml" }));
  expect(mockEstablish).toHaveBeenCalledWith("o/r", "develop", { workflowFile: "ci.yml", workspaceId: "w1" });
});
