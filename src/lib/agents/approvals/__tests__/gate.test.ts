/**
 * The control /playbook sells, executing for the first time.
 *
 * agent.write_pending_approval, agent.write_approved and agent.write_executed
 * had NEVER fired. Not once in ninety days, while the client-facing document
 * said an agent's write is held until a human approves it. The approvals store
 * was written and tested; nothing outside its own tests ever called it.
 *
 * That is the sixth control this month found declared, described accurately,
 * and wired to nothing. A control that has never executed is not a control, it
 * is a paragraph.
 *
 * So these do not test that the store works. They test that the PATH RUNS: a
 * write reaches the gate, the gate holds it, and nothing was sent.
 */

const mockQuery = jest.fn();
const mockCreatePendingApproval = jest.fn();

jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/agents/approvals/store", () => ({
  createPendingApproval: (...a: unknown[]) => mockCreatePendingApproval(...a),
  APPROVAL_TTL_HOURS: 24,
}));

import {
  holdWriteForApproval,
  isWriteOperation,
  requiresWriteApproval,
} from "@/lib/agents/approvals/gate";

const GATED = { rows: [{ requires_write_approval: true }] };
const UNGATED = { rows: [{ requires_write_approval: false }] };

const args = {
  agentId: "a1",
  workspaceId: "ws1",
  ownerUserId: "u1",
  operationId: "create_crm_record",
  method: "POST",
  params: { name: "Acme" },
  capability: "operation:create_crm_record",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreatePendingApproval.mockResolvedValue("ap-1");
});

describe("which operations are held", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "post"])("%s is a write", (m) => {
    expect(isWriteOperation(m)).toBe(true);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("%s is not", (m) => {
    /* A read behind approval would make the gate hated and teach people to
       grant blanket approval, which is how a control becomes a rubber stamp. */
    expect(isWriteOperation(m)).toBe(false);
  });
});

describe("the path runs", () => {
  it("holds a write for an agent behind the gate, and does not execute it", async () => {
    /* THE ASSERTION THAT WAS MISSING FOR NINETY DAYS. */
    mockQuery.mockResolvedValue(GATED);
    const held = await holdWriteForApproval(args);
    expect(held).not.toBeNull();
    expect(held!.approvalId).toBe("ap-1");
    expect(held!.detail).toMatch(/has not run/);
    expect(mockCreatePendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "a1", workspaceId: "ws1", tool: "create_crm_record" }),
    );
  });

  it("names WHICH approval is waiting", async () => {
    /* "Waiting for approval" with no handle is a dead end for whoever has to
       approve it. */
    mockQuery.mockResolvedValue(GATED);
    expect((await holdWriteForApproval(args))!.detail).toContain("ap-1");
  });

  it("lets an ungated agent through untouched", async () => {
    /* Seventy-three agent tasks already run here. Gating every write would
       stop them dead and teach everybody to switch the gate off, which is
       worse than not having one. */
    mockQuery.mockResolvedValue(UNGATED);
    expect(await holdWriteForApproval(args)).toBeNull();
    expect(mockCreatePendingApproval).not.toHaveBeenCalled();
  });

  it("lets a read through even for a gated agent", async () => {
    mockQuery.mockResolvedValue(GATED);
    expect(await holdWriteForApproval({ ...args, method: "GET" })).toBeNull();
    expect(mockCreatePendingApproval).not.toHaveBeenCalled();
  });
});

describe("what it does when it cannot tell", () => {
  it("holds the write when the flag cannot be read", async () => {
    /* FAILS CLOSED, unlike every other reader in this codebase, and
       deliberately. Elsewhere an unreadable source costs a missing number.
       Here it costs an unapproved write against a client's system. A held
       write is one click to release; an executed one is not. */
    mockQuery.mockRejectedValue(new Error("db down"));
    expect(await requiresWriteApproval("a1", "ws1")).toBe(true);
    expect(await holdWriteForApproval(args)).not.toBeNull();
  });

  it("holds the write for an agent it does not recognize", async () => {
    /* No row is not "no approval needed". It is a question we could not answer
       about an actor we do not recognize. */
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await requiresWriteApproval("ghost", "ws1")).toBe(true);
  });

  it("refuses rather than executing when the approval cannot be recorded", async () => {
    /* Proceeding would run the write with no record that anybody allowed it,
       which is the exact situation the gate exists to prevent. */
    mockQuery.mockResolvedValue(GATED);
    mockCreatePendingApproval.mockResolvedValue(null);
    const held = await holdWriteForApproval(args);
    expect(held).not.toBeNull();
    expect(held!.detail).toMatch(/was not run/);
  });

  it("scopes the flag lookup to the workspace", async () => {
    /* An agent id from another tenant must not answer this question. */
    mockQuery.mockResolvedValue(UNGATED);
    await requiresWriteApproval("a1", "ws1");
    expect(mockQuery.mock.calls[0][1]).toEqual(["a1", "ws1"]);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/workspace_id = \$2/);
  });
});
