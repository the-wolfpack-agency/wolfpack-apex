/**
 * create_task_form, agent path. An autonomous agent cannot fill a UI form, so
 * when dispatched by an agent principal the tool EXECUTES the create on behalf
 * of the owner (writes to the owner's Microsoft To-Do) instead of returning a
 * form. A human caller still gets the form. Graceful: a missing title, a
 * disconnected owner mailbox, or a Graph error degrade to a clear ok:false the
 * governed executor records as a failed step (never a false "succeeded").
 */

const mockListCachedTaskLists = jest.fn();
const mockCreateTask = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTaskLists: (...a: unknown[]) => mockListCachedTaskLists(...a),
  createTask: (...a: unknown[]) => mockCreateTask(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

import { createTaskFormTool } from "@/lib/assistant/tools/create-task-form-tool";

const agentCtx = {
  userId: "agent-1",
  userRole: "dev",
  workspaceId: "ws1",
  agentPrincipal: { agentId: "agent-1", role: "dev", workspaceId: "ws1", ownerUserId: "owner-9" },
};
const humanCtx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  mockListCachedTaskLists.mockReset();
  mockCreateTask.mockReset();
  mockTrackEvent.mockReset();
});

describe("agent on-behalf-of-owner task creation", () => {
  test("creates the task in the owner's first writable list and returns no form", async () => {
    mockListCachedTaskLists.mockResolvedValue([
      { id: "u-3", msListId: "CCCC", displayName: "Flagged Emails" },
      { id: "u-1", msListId: "AAAA", displayName: "Tasks" },
    ]);
    mockCreateTask.mockResolvedValue({ id: "local-1", msTaskId: "m-1", title: "Agent1 TEST" });

    const r = await createTaskFormTool.handler({ title: "Agent1 TEST" }, agentCtx);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form).toBeUndefined(); // a real create, not a form
    // Owner identity + first WRITABLE list (Flagged Emails skipped).
    expect(mockListCachedTaskLists).toHaveBeenCalledWith("owner-9");
    expect(mockCreateTask).toHaveBeenCalledWith("owner-9", "AAAA", { title: "Agent1 TEST" });
    expect(r.answer).toMatch(/Created task "Agent1 TEST"/);
  });

  test("missing title fails gracefully and never calls createTask", async () => {
    const r = await createTaskFormTool.handler({}, agentCtx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("validation");
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  test("owner with no writable list fails gracefully", async () => {
    mockListCachedTaskLists.mockResolvedValue([
      { id: "u-3", msListId: "CCCC", displayName: "Flagged Emails" },
    ]);
    const r = await createTaskFormTool.handler({ title: "X" }, agentCtx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("internal");
    expect(r.message).toMatch(/Microsoft To-Do/);
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  test("a Graph error degrades to ok:false, never throws", async () => {
    mockListCachedTaskLists.mockResolvedValue([{ id: "u-1", msListId: "AAAA", displayName: "Tasks" }]);
    mockCreateTask.mockRejectedValue(new Error("No valid Microsoft token for user"));
    const r = await createTaskFormTool.handler({ title: "X" }, agentCtx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/Could not create the task/);
  });

  test("a human caller still gets the form, never creates directly", async () => {
    mockListCachedTaskLists.mockResolvedValue([{ id: "u-1", msListId: "AAAA", displayName: "Tasks" }]);
    const r = await createTaskFormTool.handler({ title: "X" }, humanCtx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form).toBeDefined();
    expect(mockCreateTask).not.toHaveBeenCalled();
  });
});
