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

import { taskListWidgetTool } from "@/lib/assistant/tools/task-list-widget-tool";

const match = (q: string) => taskListWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "member" };

beforeEach(() => {
  mockListCachedTasks.mockReset();
  mockTrackEvent.mockReset();
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

  test("empty task list returns 'no open tasks'", async () => {
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });
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
