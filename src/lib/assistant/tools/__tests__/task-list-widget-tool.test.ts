/**
 * task_list_widget tool — intent matching + handler shape.
 */

const mockListCachedTasks = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTasks: (...a: unknown[]) => mockListCachedTasks(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));
/* Default to "a sync has run", so every test below is about the tasks
   themselves. The unsynced case is its own describe at the bottom, because it
   is a different question and used to be answered wrong. */
const mockUnsyncedNotice = jest.fn();
jest.mock("@/lib/ms-graph/sync-state", () => ({
  unsyncedNotice: (...a: unknown[]) => mockUnsyncedNotice(...a),
  getSyncState: async () => ({ everSynced: true, lastSyncedAt: null }),
}));

import { taskListWidgetTool } from "@/lib/assistant/tools/task-list-widget-tool";

const match = (q: string) => taskListWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "member" };

beforeEach(() => {
  mockListCachedTasks.mockReset();
  mockTrackEvent.mockReset();
  mockUnsyncedNotice.mockReset();
  mockUnsyncedNotice.mockResolvedValue(null);
});

describe("task_list_widget intent matching", () => {
  test.each([
    "tasks",
    "Tasks",
    "my tasks",
    "open tasks",
    "show me my tasks",
    "show tasks",
    "task list",
    "to-do list",
    "todo list",
    "todos",
    "todo",
    "tasks.",
    "tasks?",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "create task",
    "add a task",
    "any tasks for hoxsie",
    "tasks due this week",
    "completed tasks",
  ])("'%s' does NOT match (left to other tools)", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("task_list_widget handler", () => {
  test("maps cached tasks + counts overdue", async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    mockListCachedTasks.mockResolvedValue({
      tasks: [
        {
          id: "t1",
          msTaskId: "ms-t1",
          listId: "l1",
          title: "Overdue thing",
          status: "notStarted",
          importance: "high",
          dueAt: past,
        },
        {
          id: "t2",
          msTaskId: "ms-t2",
          listId: "l1",
          title: "Soon thing",
          status: "inProgress",
          importance: "normal",
          dueAt: future,
        },
        {
          id: "t3",
          msTaskId: "ms-t3",
          listId: "l1",
          title: "Done thing",
          status: "completed",
          importance: "low",
          dueAt: null,
        },
      ],
      nextCursor: null,
    });
    const res = await taskListWidgetTool.handler({ limit: 20 }, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const spec = res.widget as { kind: "task_list"; tasks: { id: string }[] };
    /* Completed task is filtered out. */
    expect(spec.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(res.answer).toMatch(/1 overdue/);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "member",
      expect.objectContaining({
        widget_kind: "task_list",
        task_count: 2,
        overdue_count: 1,
      }),
    );
  });

  /* ONLY ONCE A SYNC HAS RUN. This asserted the answer unconditionally, which
     made it a test that pinned a bug: instinct_ms_tasks has never held a row
     in production, so in reality this branch was telling everybody they had no
     tasks regardless of their To-Do list. The unsynced half is asserted in its
     own describe below. */
  test("empty task list returns 'no open tasks' when the mirror has been synced", async () => {
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mockUnsyncedNotice.mockResolvedValue(null);
    const res = await taskListWidgetTool.handler({ limit: 20 }, CTX);
    if (!res.ok) return;
    expect(res.answer).toMatch(/no open tasks/i);
  });

  test("cache failure → friendly answer, empty widget", async () => {
    mockListCachedTasks.mockRejectedValue(new Error("DB down"));
    const res = await taskListWidgetTool.handler({ limit: 20 }, CTX);
    if (!res.ok) return;
    expect((res.widget as { tasks: unknown[] }).tasks).toEqual([]);
    expect(res.answer).toMatch(/couldn't load/i);
  });
});

/**
 * AN EMPTY MIRROR IS NOT AN EMPTY TO-DO LIST.
 *
 * Added 2026-08-28. instinct_ms_tasks has never held a row in production and
 * no cron syncs it, so this tool answered "You have no open tasks. Nice." to
 * everybody regardless of what was in their Microsoft To-Do. Nothing failed:
 * the read returned [] exactly as designed, and [] is a fine answer to a
 * question nobody had checked was askable.
 */
describe("an unsynced mirror never claims you have nothing", () => {
  it("says the tasks were never synced rather than that there are none", async () => {
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    mockUnsyncedNotice.mockResolvedValue(
      "Your Microsoft tasks have not been synced yet, so I cannot tell you whether there are any. Connect Microsoft 365 in Settings.",
    );
    const res = await taskListWidgetTool.handler({ limit: 20 }, CTX);
    if (!res.ok) throw new Error("expected a result");
    expect(res.answer).toContain("not been synced");
    expect(res.answer).not.toContain("no open tasks");
  });

  it("asks about tasks using the reader's word for them", async () => {
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
    await taskListWidgetTool.handler({ limit: 20 }, CTX);
    expect(mockUnsyncedNotice).toHaveBeenCalledWith("u1", "tasks", "tasks");
  });

  /* Never asked when there ARE tasks: the question does not arise, and asking
     would spend a query per answer to learn something irrelevant. */
  it("does not ask when the list is not empty", async () => {
    mockListCachedTasks.mockResolvedValue({
      tasks: [{ id: "1", title: "A", status: "notStarted", importance: "normal", dueAt: null, listId: "L" }],
      nextCursor: null,
    });
    await taskListWidgetTool.handler({ limit: 20 }, CTX);
    expect(mockUnsyncedNotice).not.toHaveBeenCalled();
  });
});
