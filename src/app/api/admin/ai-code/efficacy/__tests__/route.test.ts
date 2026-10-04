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
jest.mock("@/lib/ai-code/loop-efficacy", () => ({ loadLoopEfficacy: (...a: unknown[]) => mockLoad(...a) }));

import { GET } from "../route";
const get = (qs = "") => new NextRequest(`http://localhost/api/admin/ai-code/efficacy${qs}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockServiceAuth.mockReturnValue(null);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockLoad.mockResolvedValue({ windowDays: 30, runs: 4, firstPassReadyRate: 0.75, acceptanceRate: 0.66, duplicationRate: 0.25, reuseSemanticRate: 0.5, repeatFindingRate: 0.33, readyTrend: "up" });
});

it("401 unauth / 403 unentitled", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(get())).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(get())).status).toBe(403);
});

it("200 returns the efficacy metrics (workspace-scoped, default 30d)", async () => {
  const res = await GET(get());
  expect(res.status).toBe(200);
  expect((await res.json()).efficacy).toMatchObject({ firstPassReadyRate: 0.75, readyTrend: "up" });
  expect(mockLoad).toHaveBeenCalledWith("w1", 30);
});

it("honours ?days=", async () => {
  await GET(get("?days=7"));
  expect(mockLoad).toHaveBeenCalledWith("w1", 7);
});

it("ignores a non-positive days (falls back to 30)", async () => {
  await GET(get("?days=0"));
  expect(mockLoad).toHaveBeenCalledWith("w1", 30);
});

it("accepts the factory service token", async () => {
  mockServiceAuth.mockReturnValue({ ok: true, user: { id: "svc", role: "service", workspaceId: "w1" } });
  expect((await GET(get())).status).toBe(200);
  expect(mockRequireCapability).not.toHaveBeenCalled();
});
