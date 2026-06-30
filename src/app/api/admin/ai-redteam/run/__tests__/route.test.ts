/**
 * Contract tests for /api/admin/ai-redteam/run (POST run + GET history). Auth
 * (401/403), the POST report passthrough scoped to the workspace, and GET
 * history. The execute + store libs are mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockExecute = jest.fn();
const mockList = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/ai-redteam/execute", () => ({ executeRedTeam: (...a: unknown[]) => mockExecute(...a) }));
jest.mock("@/lib/ai-redteam/store", () => ({ listRuns: (...a: unknown[]) => mockList(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "../route";

const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });
const req = (m: string) => new NextRequest("https://x.test/api/admin/ai-redteam/run", { method: m, headers: { authorization: "Bearer t" } });

beforeEach(() => {
  jest.resetAllMocks();
  mockList.mockResolvedValue([]);
  mockExecute.mockResolvedValue({ report: { attacksRun: 8, blocked: 8, vulns: [], passRate: 1, byCategory: {} }, id: "art_x" });
});

test("GET 401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await GET(req("GET"))).status).toBe(401);
});

test("POST 403 when lacking capability", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await POST(req("POST"))).status).toBe(403);
});

test("POST runs the corpus scoped to the workspace and returns the report", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await POST(req("POST"));
  expect(res.status).toBe(200);
  expect((await res.json()).report.passRate).toBe(1);
  expect(mockExecute).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "w-1", actorId: "u-1", actorRole: "cto", source: "manual" }),
  );
});

test("GET returns the run history", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockList.mockResolvedValue([{ id: "art_x", attacksRun: 8, blocked: 8, vulns: 0, passRate: 1, risk: "low", source: "cron", createdAt: "t" }]);
  const res = await GET(req("GET"));
  expect((await res.json()).runs).toHaveLength(1);
  expect(mockList).toHaveBeenCalledWith("w-1");
});
