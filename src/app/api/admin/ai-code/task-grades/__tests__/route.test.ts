/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockServiceAuth = jest.fn();
const mockGate = jest.fn();
const mockLoad = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/ai-code/factory-service-auth", () => ({ factoryServiceAuth: (...a: unknown[]) => mockServiceAuth(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/auth/workspace", () => ({ resolveWorkspace: (w: string) => w }));
jest.mock("@/lib/ai-code/task-type", () => ({ loadTaskTypeGrades: (...a: unknown[]) => mockLoad(...a) }));

import { GET } from "../route";
const get = (qs = "") => new NextRequest(`http://localhost/api/admin/ai-code/task-grades${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockServiceAuth.mockReturnValue(null);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockLoad.mockResolvedValue({ windowDays: 30, byModelTask: [{ model: "gpt-a", taskType: "migration", runs: 3, readyRate: 0.66 }] });
});

it("401/403", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(get())).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(get())).status).toBe(403);
});

it("200 returns the grades (workspace-scoped, default 30d)", async () => {
  const res = await GET(get());
  expect(res.status).toBe(200);
  expect((await res.json()).grades.byModelTask[0]).toMatchObject({ model: "gpt-a", taskType: "migration" });
  expect(mockLoad).toHaveBeenCalledWith("w1", 30);
});

it("honours ?days=", async () => {
  await GET(get("?days=7"));
  expect(mockLoad).toHaveBeenCalledWith("w1", 7);
});
