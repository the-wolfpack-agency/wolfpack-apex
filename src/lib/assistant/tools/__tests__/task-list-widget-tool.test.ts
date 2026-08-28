/**
 * task_list_widget tool — intent matching + handler shape.
 */

const mockListOpenTasksLive = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listOpenTasksLive: (...a: unknown[]) => mockListOpenTasksLive(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));


import { taskListWidgetTool } from "@/lib/assistant/tools/task-list-widget-tool";

const match = (q: string) => taskListWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "member" };

beforeEach(() => {
  mockListOpenTasksLive.mockReset();
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
    mockListOpenTasksLive.mockResolvedValue({ ok: true, tasks: [
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

  /* This asserted the answer unconditionally, which made it a test that pinned
     a bug: the mirror it read had never held a row, so in reality the branch
     told everybody they had no tasks regardless of their To-Do list. It now
     names the case it covers, which is a SUCCESSFUL live read that returned
     nothing. The failure cases have their own describe below. */
  test("empty task list returns 'no open tasks' when Microsoft answered with none", async () => {
    mockListOpenTasksLive.mockResolvedValue({ ok: true, tasks: [] });
    const res = await taskListWidgetTool.handler({ limit: 20 }, CTX);
    if (!res.ok) return;
    expect(res.answer).toMatch(/no open tasks/i);
  });

  test("cache failure → friendly answer, empty widget", async () => {
    mockListOpenTasksLive.mockRejectedValue(new Error("DB down"));
    const res = await taskListWidgetTool.handler({ limit: 20 }, CTX);
    if (!res.ok) return;
    expect((res.widget as { tasks: unknown[] }).tasks).toEqual([]);
    expect(res.answer).toMatch(/couldn't load/i);
  });
});

/**
 * THE MIRROR IS NO LONGER READ AT ALL.
 *
 * #498 taught this tool to say "your tasks have not been synced yet" instead
 * of "you have no open tasks", because instinct_ms_tasks had never held a row
 * and nothing scheduled the sync that would fill it. This change removes the
 * reason to say either: the read is live, so Microsoft is actually asked.
 *
 * What replaces the unsynced notice is a named reason per failure, because
 * "not connected", "no permission" and "rate limited" lead somewhere different
 * and none of them is "you have no tasks".
 */
describe("a failure names itself and never reads as an empty list", () => {
  it.each([
    ["not_connected", /not connected yet/i],
    ["scope_missing", /permission/i],
    ["rate_limited", /rate-limiting/i],
    ["unavailable", /could not reach Microsoft/i],
  ])("reports %s in its own words", async (reason, expected) => {
    mockListOpenTasksLive.mockResolvedValue({ ok: false, reason });
    const res = await taskListWidgetTool.handler({ limit: 20 }, CTX);
    if (!res.ok) throw new Error("expected a served result");
    expect(res.answer).toMatch(expected);
    /* THE ASSERTION THAT MATTERS. Every one of these used to render as an
       empty task list, which a reader cannot tell from having no tasks. */
    expect(res.answer).not.toMatch(/no open tasks/i);
  });

  /* An empty list from a successful read is genuinely empty: Microsoft was
     asked and said so. Refusing to say it would be its own lie. */
  it("still says you have none when Microsoft answers with none", async () => {
    mockListOpenTasksLive.mockResolvedValue({ ok: true, tasks: [] });
    const res = await taskListWidgetTool.handler({ limit: 20 }, CTX);
    if (!res.ok) throw new Error("expected a served result");
    expect(res.answer).toBe("You have no open tasks. Nice.");
  });

  it("reads live rather than from the mirror", async () => {
    mockListOpenTasksLive.mockResolvedValue({ ok: true, tasks: [] });
    await taskListWidgetTool.handler({ limit: 20 }, CTX);
    expect(mockListOpenTasksLive).toHaveBeenCalledWith("u1", { limit: 20 });
  });
});
