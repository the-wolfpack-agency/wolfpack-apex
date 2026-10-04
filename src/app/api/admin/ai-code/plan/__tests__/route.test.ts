/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockServiceAuth = jest.fn();
const mockGate = jest.fn();
const mockTrack = jest.fn();
const mockComplete = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/ai-code/factory-service-auth", () => ({ factoryServiceAuth: (...a: unknown[]) => mockServiceAuth(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/ai", () => ({ getAIClient: () => ({ complete: (...a: unknown[]) => mockComplete(...a) }) }));

import { POST } from "../route";
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ai-code/plan", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  jest.clearAllMocks();
  mockServiceAuth.mockReturnValue(null);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockComplete.mockResolvedValue({
    content: JSON.stringify([
      { title: "Schema", instruction: "Add table", rationale: "foundation", sensitive: true },
      { title: "API", instruction: "Add route" },
    ]),
    model_used: "test-model",
    provider_used: "test",
  });
});

it("401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await POST(post({ goal: "x" }))).status).toBe(401);
});

it("403 when the workspace lacks the secure_agent entitlement", async () => {
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await POST(post({ goal: "x" }))).status).toBe(403);
});

it("400 when goal is missing or blank", async () => {
  expect((await POST(post({}))).status).toBe(400);
  expect((await POST(post({ goal: "   " }))).status).toBe(400);
  expect(mockComplete).not.toHaveBeenCalled(); // never calls the model on a bad request
});

it("200 returns a propose-only plan; nothing is executed", async () => {
  const res = await POST(post({ goal: "add rate limiting with quotas and an admin view" }));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.plan.steps.map((s: { id: string }) => s.id)).toEqual(["step-1", "step-2"]);
  expect(json.plan.steps[0].sensitive).toBe(true);
  expect(json.plan.model).toBe("test-model");
  expect(mockTrack).toHaveBeenCalledWith(
    "ai_code.plan_proposed",
    "u1",
    "admin",
    expect.objectContaining({ workspace_id: "w1", steps: 2, truncated: false }),
  );
});

it("200 with an empty plan when the model fails (never a 500)", async () => {
  mockComplete.mockRejectedValue(new Error("router down"));
  const res = await POST(post({ goal: "x" }));
  expect(res.status).toBe(200);
  expect((await res.json()).plan.steps).toEqual([]);
});

it("accepts the factory service token in place of a user login", async () => {
  mockServiceAuth.mockReturnValue({ ok: true, user: { id: "svc", role: "service", workspaceId: "w1" } });
  const res = await POST(post({ goal: "x" }));
  expect(res.status).toBe(200);
  expect(mockRequireCapability).not.toHaveBeenCalled();
});
