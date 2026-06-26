/**
 * Contract + e2e for POST /api/admin/agents/approvals/[id].
 *
 * Proves the human-in-the-loop write completion:
 *   - approve -> kill-switch re-check passes -> the EXACT captured write runs ON
 *     THE OWNER's behalf -> outcome recorded + audited + marked executed.
 *   - reject -> nothing mutates.
 *   - a paused/revoked agent (kill switch) -> auto-rejected, NO write.
 *   - already-decided / not-pending -> 409, NO write.
 * The write executor + the store are mocked, so the route's authorization,
 * re-gating, and on-behalf wiring are exercised without a DB or a real CRM.
 */
const mockGetPending = jest.fn();
const mockDecide = jest.fn();
const mockMarkExecuted = jest.fn();
const mockGetAgent = jest.fn();
const mockExecuteCreate = jest.fn();
const mockRecordAudit = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } }),
}));
jest.mock("@/lib/agents/approvals/store", () => ({
  getPendingApproval: (...a: unknown[]) => mockGetPending(...a),
  decidePendingApproval: (...a: unknown[]) => mockDecide(...a),
  markApprovalExecuted: (...a: unknown[]) => mockMarkExecuted(...a),
}));
jest.mock("@/lib/agents/store", () => ({ getAgent: (...a: unknown[]) => mockGetAgent(...a) }));
jest.mock("@/lib/assistant/tools/create-external-record-tool", () => ({
  executeCreateExternalRecord: (...a: unknown[]) => mockExecuteCreate(...a),
}));
jest.mock("@/lib/assistant/tools/update-external-record-tool", () => ({ executeUpdateExternalRecord: jest.fn() }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "r1" }),
}));
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/agents/approvals/[id]/route";

const APPROVAL = {
  id: "ap-1", workspaceId: "ws-1", agentId: "agent-1", ownerUserId: "owner-1",
  tool: "create_external_record", params: { objectType: "contact", fields: { Name: "Jane" }, connector: "salesforce" },
  capability: "*", decisionSeq: 7, status: "pending" as const,
  createdAt: "t", expiresAt: "t2", decidedBy: null, decidedAt: null, outcome: null,
};
function post(action: string) {
  const req = new NextRequest("http://localhost/api/admin/agents/approvals/ap-1", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
  });
  return POST(req, { params: Promise.resolve({ id: "ap-1" }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPending.mockResolvedValue({ ...APPROVAL });
  mockDecide.mockImplementation(async (_id, _ws, by, decision) => ({ ...APPROVAL, status: decision, decidedBy: by }));
  mockMarkExecuted.mockResolvedValue(undefined);
  mockGetAgent.mockResolvedValue({ id: "agent-1", state: "active" });
  mockExecuteCreate.mockResolvedValue({ ok: true, id: "sf-100", connector: "salesforce" });
  mockRecordAudit.mockResolvedValue(undefined);
  mockSafeQuery.mockResolvedValue({ rows: [{ role: "member", workspace_id: "ws-1" }] });
});

it("APPROVE executes the captured write ON THE OWNER's behalf, then records + marks it executed", async () => {
  const res = await post("approve");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, status: "executed" });
  // the EXACT captured params ran, attributed to the OWNER (not the approver).
  expect(mockExecuteCreate).toHaveBeenCalledWith(
    APPROVAL.params,
    expect.objectContaining({ userId: "owner-1", workspaceId: "ws-1" }),
  );
  expect(mockMarkExecuted).toHaveBeenCalledWith("ap-1", "ws-1", expect.objectContaining({ ok: true }));
  expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "agent.write.approved_executed" }));
});

it("REJECT records the decision and NEVER executes the write", async () => {
  const res = await post("reject");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "rejected" });
  expect(mockExecuteCreate).not.toHaveBeenCalled();
  expect(mockDecide).toHaveBeenCalledWith("ap-1", "ws-1", "admin-1", "rejected");
});

it("KILL SWITCH: a paused/revoked agent auto-rejects the approval with NO write", async () => {
  mockGetAgent.mockResolvedValue({ id: "agent-1", state: "paused" });
  const res = await post("approve");
  expect(res.status).toBe(409);
  expect(mockExecuteCreate).not.toHaveBeenCalled();
  expect(mockDecide).toHaveBeenCalledWith("ap-1", "ws-1", "admin-1", "rejected"); // stale -> auto-reject
});

it("a non-pending approval is refused (409) with no write", async () => {
  mockGetPending.mockResolvedValue({ ...APPROVAL, status: "executed" });
  const res = await post("approve");
  expect(res.status).toBe(409);
  expect(mockExecuteCreate).not.toHaveBeenCalled();
});

it("a race that loses the atomic claim does not double-execute", async () => {
  mockDecide.mockResolvedValue(null); // someone else already approved between read and claim
  const res = await post("approve");
  expect(res.status).toBe(409);
  expect(mockExecuteCreate).not.toHaveBeenCalled();
});

it("rejects an invalid action", async () => {
  expect((await post("nuke")).status).toBe(400);
});
