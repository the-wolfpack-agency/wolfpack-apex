/**
 * create_task_form, agent path (post-generic-execution).
 *
 * The bespoke per-tool "createTaskAsAgent" path is GONE. The tool now always
 * returns a FormSpec; the generic agent executor auto-fills it and executes it
 * on the owner's behalf. The one tool-level responsibility that remains is that
 * when an agent dispatches it, the form's list dropdown is built with the
 * OWNER's writable To-Do lists (via ctx.onBehalfOfUserId), so the form carries a
 * real default listId the executor can submit. A human caller (no
 * onBehalfOfUserId) gets the form built with their own lists.
 */

const mockListCachedTaskLists = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTaskLists: (...a: unknown[]) => mockListCachedTaskLists(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

import { createTaskFormTool } from "@/lib/assistant/tools/create-task-form-tool";

const agentCtx = {
  userId: "agent-1",
  userRole: "dev",
  workspaceId: "ws1",
  onBehalfOfUserId: "owner-9",
  agentPrincipal: { agentId: "agent-1", role: "dev", workspaceId: "ws1", ownerUserId: "owner-9" },
};
const humanCtx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  mockListCachedTaskLists.mockReset();
  mockTrackEvent.mockReset();
});

describe("create_task_form built for the effective (owner) user", () => {
  test("agent dispatch builds the form with the OWNER's writable lists + a real default", async () => {
    mockListCachedTaskLists.mockResolvedValue([
      { id: "u-3", msListId: "CCCC", displayName: "Flagged Emails" }, // read-only, skipped
      { id: "u-1", msListId: "AAAA", displayName: "Tasks" },
    ]);

    const r = await createTaskFormTool.handler({ title: "Agent1 TEST" }, agentCtx);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // It returns the form (the generic executor handles execution).
    expect(r.form).toBeDefined();
    // Built for the OWNER, not the agent identity.
    expect(mockListCachedTaskLists).toHaveBeenCalledWith("owner-9");
    // The list dropdown carries the owner's first WRITABLE list as the default
    // (Flagged Emails filtered out), so the executor submits a real listId.
    const listField = r.form!.fields.find((f) => f.name === "listId");
    expect(listField?.type).toBe("select");
    expect(listField?.defaultValue).toBe("AAAA");
    // Title prefill flows through.
    const titleField = r.form!.fields.find((f) => f.name === "title");
    expect(titleField?.defaultValue).toBe("Agent1 TEST");
  });

  test("a human caller builds the form with their OWN lists", async () => {
    mockListCachedTaskLists.mockResolvedValue([{ id: "u-1", msListId: "HUMN", displayName: "Tasks" }]);
    const r = await createTaskFormTool.handler({ title: "X" }, humanCtx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form).toBeDefined();
    expect(mockListCachedTaskLists).toHaveBeenCalledWith("u1");
    const listField = r.form!.fields.find((f) => f.name === "listId");
    expect(listField?.defaultValue).toBe("HUMN");
  });

  test("empty owner lists still returns a (text) listId form, with no crash", async () => {
    mockListCachedTaskLists.mockResolvedValue([]);
    const r = await createTaskFormTool.handler({ title: "X" }, agentCtx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form).toBeDefined();
    const listField = r.form!.fields.find((f) => f.name === "listId");
    // No options -> the spec falls back to a text input the executor will report
    // as missing-required (the executor then blocks + notifies the owner).
    expect(listField?.type).toBe("text");
    expect(listField?.defaultValue).toBeUndefined();
  });

  test("a cache failure degrades to an empty-list form instead of throwing", async () => {
    mockListCachedTaskLists.mockRejectedValue(new Error("db down"));
    const r = await createTaskFormTool.handler({ title: "X" }, agentCtx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.form).toBeDefined();
  });

  test("fires the form_offered analytics event flagged on_behalf_of_owner for an agent dispatch", async () => {
    mockListCachedTaskLists.mockResolvedValue([{ id: "u-1", msListId: "AAAA", displayName: "Tasks" }]);
    await createTaskFormTool.handler({ title: "X" }, agentCtx);
    const call = mockTrackEvent.mock.calls.find((c) => c[0] === "assistant.form_offered");
    expect(call).toBeDefined();
    expect(call?.[3]).toEqual(expect.objectContaining({ form_kind: "create_task", on_behalf_of_owner: true }));
  });
});
