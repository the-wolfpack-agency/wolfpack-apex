/**
 * @jest-environment node
 *
 * Contract for GET /api/admin/ai-code/benchmark/models: gating + { models }.
 */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockGate = jest.fn();
const mockAvailable = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/ai-code/model-benchmark", () => ({ availableBenchmarkModels: (...a: unknown[]) => mockAvailable(...a) }));

import { GET } from "../route";

const req = () => new NextRequest("http://localhost/api/admin/ai-code/benchmark/models");

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockAvailable.mockReturnValue([{ pin: "gpt-4o-mini", provider: "openai", tier: "small", label: "gpt-4o-mini" }]);
});

it("401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(req())).status).toBe(401);
});

it("403 when not entitled", async () => {
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(req())).status).toBe(403);
});

it("200 returns the available benchmark models", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.models).toEqual([{ pin: "gpt-4o-mini", provider: "openai", tier: "small", label: "gpt-4o-mini" }]);
});
