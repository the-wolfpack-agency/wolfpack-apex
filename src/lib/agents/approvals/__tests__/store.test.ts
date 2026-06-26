/**
 * Agent write-approval store: capture, atomic decide (the WHERE status='pending'
 * guard makes double-decide impossible), list, and execute-marking. DB +
 * analytics mocked. Every state change emits a learning event (no data lost).
 */
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import {
  createPendingApproval, decidePendingApproval, listPendingApprovals, markApprovalExecuted,
} from "@/lib/agents/approvals/store";

const ROW = {
  id: "ap-1", workspace_id: "ws-1", agent_id: "agent-1", owner_user_id: "owner-1",
  tool: "create_external_record", params: { objectType: "contact" }, capability: "*",
  decision_seq: "7", status: "pending", created_at: "t", expires_at: "t2",
  decided_by: null, decided_at: null, outcome: null,
};

let savedDbUrl: string | undefined;
beforeAll(() => { savedDbUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = "postgres://x"; });
afterAll(() => { if (savedDbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDbUrl; });
beforeEach(() => jest.clearAllMocks());

it("captures a proposal and emits agent.write_pending_approval", async () => {
  mockQuery.mockResolvedValue({ rows: [{ id: "ap-1" }] });
  const id = await createPendingApproval({
    workspaceId: "ws-1", agentId: "agent-1", ownerUserId: "owner-1",
    tool: "create_external_record", params: { objectType: "contact" }, capability: "*", decisionSeq: 7,
  });
  expect(id).toBe("ap-1");
  expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO instinct_agent_pending_approvals/);
  expect(mockTrack).toHaveBeenCalledWith("agent.write_pending_approval", "agent-1", "agent", expect.objectContaining({ approval_id: "ap-1" }));
});

it("returns null (no capture) when there is no database", async () => {
  const old = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  expect(await createPendingApproval({ workspaceId: "w", agentId: "a", ownerUserId: "o", tool: "t", params: {}, capability: "*" })).toBeNull();
  expect(mockQuery).not.toHaveBeenCalled();
  process.env.DATABASE_URL = old;
});

it("decide moves a pending approval and emits the decision event", async () => {
  mockQuery.mockResolvedValue({ rows: [{ ...ROW, status: "approved" }] });
  const r = await decidePendingApproval("ap-1", "ws-1", "admin-1", "approved");
  expect(r?.status).toBe("approved");
  expect(mockQuery.mock.calls[0][0]).toMatch(/status = 'pending'/); // the atomic guard
  expect(mockTrack).toHaveBeenCalledWith("agent.write_approved", "agent-1", "agent", expect.objectContaining({ decided_by: "admin-1" }));
});

it("ATOMICITY: decide returns null when the row was already decided (no double-decide)", async () => {
  mockQuery.mockResolvedValue({ rows: [] }); // WHERE status='pending' matched nothing
  expect(await decidePendingApproval("ap-1", "ws-1", "admin-1", "approved")).toBeNull();
  expect(mockTrack).not.toHaveBeenCalled();
});

it("lists only pending, non-expired approvals for the workspace", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [ROW] });
  const list = await listPendingApprovals("ws-1");
  expect(list[0]).toMatchObject({ id: "ap-1", tool: "create_external_record", decisionSeq: 7 });
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/status = 'pending' AND expires_at > now\(\)/);
  // No agentId -> the $2 guard is null so every agent's writes are returned.
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", null]);
});

it("narrows the queue to a single agent when agentId is given", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [ROW] });
  await listPendingApprovals("ws-1", "agent-9");
  expect(mockSafeQuery.mock.calls[0][0]).toMatch(/\$2::text IS NULL OR agent_id = \$2/);
  expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", "agent-9"]);
});

it("marks an approval executed and emits agent.write_executed", async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await markApprovalExecuted("ap-1", "ws-1", { ok: true });
  expect(mockQuery.mock.calls[0][0]).toMatch(/status = 'executed'/);
  expect(mockTrack).toHaveBeenCalledWith("agent.write_executed", "system", "system", expect.objectContaining({ ok: true }));
});
