/**
 * create_task_form — writable-list dropdown.
 *
 * Regression: 2026-05-17, submitting "create task" from chat 400'd at
 * Graph with `ErrorInvalidIdMalformed` because the form sent listId=
 * "default" (a sentinel the upstream couldn't resolve). The fix: the
 * tool handler fetches the user's writable To-Do lists and bakes
 * them into the form as a `select` dropdown. The Flagged Emails list
 * is read-only and is filtered out (same logic as the /tasks modal).
 */

const mockListCachedTaskLists = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTaskLists: (...a: unknown[]) => mockListCachedTaskLists(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));

import { createTaskFormTool } from "@/lib/assistant/tools/create-task-form-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  mockListCachedTaskLists.mockReset();
  mockTrackEvent.mockReset();
});

describe("listId dropdown population", () => {
  test("populates the dropdown from writable lists; filters Flagged Emails", async () => {
    mockListCachedTaskLists.mockResolvedValue([
      { id: "u-1", msListId: "AAAA", displayName: "Tasks", isOwner: true, isShared: false },
      { id: "u-2", msListId: "BBBB", displayName: "Work", isOwner: true, isShared: false },
      { id: "u-3", msListId: "CCCC", displayName: "Flagged Emails", isOwner: true, isShared: false },
    ]);
    const r = await createTaskFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    const listField = r.form?.fields.find((f) => f.name === "listId");
    expect(listField?.type).toBe("select");
    expect(listField?.required).toBe(true);
    expect(listField?.options).toEqual([
      { value: "AAAA", label: "Tasks" },
      { value: "BBBB", label: "Work" },
    ]);
    expect(listField?.defaultValue).toBe("AAAA");
  });

  test("renders a text-input fallback when the user has no synced lists", async () => {
    mockListCachedTaskLists.mockResolvedValue([]);
    const r = await createTaskFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    const listField = r.form?.fields.find((f) => f.name === "listId");
    expect(listField?.type).toBe("text");
    expect(listField?.required).toBe(true);
    expect(listField?.helpText).toMatch(/sync/i);
  });

  test("falls back gracefully when the list fetch throws", async () => {
    mockListCachedTaskLists.mockRejectedValue(new Error("DB down"));
    const r = await createTaskFormTool.handler({}, ctx);
    if (!r.ok) throw new Error("expected ok");
    const listField = r.form?.fields.find((f) => f.name === "listId");
    expect(listField).toBeDefined();
    expect(listField?.type).toBe("text");
  });

  test("emits analytics with list_count", async () => {
    mockListCachedTaskLists.mockResolvedValue([
      { id: "u-1", msListId: "AAAA", displayName: "Tasks", isOwner: true, isShared: false },
    ]);
    await createTaskFormTool.handler({}, ctx);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.form_offered",
      "u1",
      "cto",
      expect.objectContaining({ form_kind: "create_task", list_count: 1 }),
    );
  });
});
