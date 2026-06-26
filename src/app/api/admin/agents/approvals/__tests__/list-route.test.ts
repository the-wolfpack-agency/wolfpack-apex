/**
 * Contract for GET /api/admin/agents/approvals (the pending-write queue list).
 * Gated on settings.manage_team; an optional ?agentId scopes the queue to one
 * agent (the agent detail page uses it). The store is mocked so the route's
 * auth + param wiring is exercised without a DB.
 */
const mockList = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
const mockHistory = jest.fn();
jest.mock("@/lib/agents/approvals/store", () => ({
  listPendingApprovals: (...a: unknown[]) => mockList(...a),
  listAgentApprovalHistory: (...a: unknown[]) => mockHistory(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/agents/approvals/route";

function get(url: string) {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockList.mockResolvedValue([{ id: "ap-1" }]);
  mockHistory.mockResolvedValue([{ id: "h-1", status: "executed" }]);
});

it("returns the workspace queue (no agentId) for an authorized admin", async () => {
  const res = await get("http://localhost/api/admin/agents/approvals");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ approvals: [{ id: "ap-1" }] });
  // workspace scope, agentId undefined -> whole-workspace queue.
  expect(mockList).toHaveBeenCalledWith("ws-1", undefined);
});

it("scopes the queue to one agent when ?agentId is given", async () => {
  await get("http://localhost/api/admin/agents/approvals?agentId=agent-9");
  expect(mockList).toHaveBeenCalledWith("ws-1", "agent-9");
});

it("includes decided history when ?history=1 with an agentId", async () => {
  const res = await get("http://localhost/api/admin/agents/approvals?agentId=agent-9&history=1");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ approvals: [{ id: "ap-1" }], history: [{ id: "h-1", status: "executed" }] });
  expect(mockHistory).toHaveBeenCalledWith("ws-1", "agent-9");
});

it("does NOT include history without the flag (or without an agentId)", async () => {
  await get("http://localhost/api/admin/agents/approvals?agentId=agent-9");
  expect(mockHistory).not.toHaveBeenCalled();
});

it("401/403s when the capability gate fails (no list call)", async () => {
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await get("http://localhost/api/admin/agents/approvals");
  expect(res.status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});
