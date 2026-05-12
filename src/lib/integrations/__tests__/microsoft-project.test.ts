/**
 * microsoft-project integration tests.
 *
 * Covers searchProjectTasks: Planner happy path with plan-title resolution,
 * substring filter (only matching tasks return), topN cap, To Do fallback
 * after Planner 403, and total 403 -> typed scope_missing (never throws).
 */
 

export {};

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrack(...args),
}));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => { (global as any).fetch = fetchMock; });
afterAll(() => { (global as any).fetch = realFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
});

function ok(data: unknown, headers: Record<string, string> = {}, status = 200): any {
  return {
    ok: true,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function err(status: number, body: any = {}, headers: Record<string, string> = {}): any {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("searchProjectTasks - Planner happy path", () => {
  it("filters tasks by substring + resolves plan title + maps status", async () => {
    // 1. /me/planner/tasks
    fetchMock.mockResolvedValueOnce(ok({
      value: [
        { id: "t1", planId: "plan-1", title: "Launch beta to apex dealers",
          percentComplete: 50, dueDateTime: "2026-05-01T00:00:00Z",
          assignments: { "user-a": {}, "user-b": {} } },
        { id: "t2", planId: "plan-1", title: "Order more coffee", percentComplete: 0 },
        { id: "t3", planId: "plan-2", title: "Beta launch retro", percentComplete: 100 },
      ],
    }));
    // 2. plan title resolution for plan-1
    fetchMock.mockResolvedValueOnce(ok({ id: "plan-1", title: "Q2 Roadmap" }));
    // 3. plan title resolution for plan-2
    fetchMock.mockResolvedValueOnce(ok({ id: "plan-2", title: "Marketing" }));
    // 4. /planner/tasks/t2/details - description fetch since t2 title
    //    didn't match (titleScore == 0 triggers a details lookup)
    fetchMock.mockResolvedValueOnce(ok({ description: "" }));
    // 5. To Do lists - empty (so we don't pollute the result)
    fetchMock.mockResolvedValueOnce(ok({ value: [] }));

    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("tok", { query: "launch beta" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();

    // "Order more coffee" should not match.
    const titles = r.value.tasks.map((t) => t.title);
    expect(titles).toEqual(expect.arrayContaining([
      "Launch beta to apex dealers",
      "Beta launch retro",
    ]));
    expect(titles).not.toContain("Order more coffee");

    const t1 = r.value.tasks.find((t) => t.id === "t1")!;
    expect(t1.plan_or_list_name).toBe("Q2 Roadmap");
    expect(t1.status).toBe("in_progress");
    expect(t1.due_at).toBe("2026-05-01T00:00:00Z");
    expect(t1.assignees).toEqual(["user-a", "user-b"]);
    expect(t1.url).toContain("tasks.office.com");

    const t3 = r.value.tasks.find((t) => t.id === "t3")!;
    expect(t3.status).toBe("completed");
  });

  it("respects topN cap", async () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`, planId: "plan-1", title: `match alpha ${i}`, percentComplete: 0,
    }));
    fetchMock.mockResolvedValueOnce(ok({ value: tasks }));
    fetchMock.mockResolvedValueOnce(ok({ id: "plan-1", title: "P" }));
    fetchMock.mockResolvedValueOnce(ok({ value: [] })); // todo lists
    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("tok", { query: "alpha", topN: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.tasks).toHaveLength(5);
  });

  it("clamps topN to TOP_N_CAP", async () => {
    const { __internal } = await import("@/lib/integrations/microsoft-project");
    const tasks = Array.from({ length: __internal.TOP_N_CAP + 50 }, (_, i) => ({
      id: `t${i}`, planId: "plan-1", title: `match X ${i}`, percentComplete: 0,
    }));
    fetchMock.mockResolvedValueOnce(ok({ value: tasks }));
    fetchMock.mockResolvedValueOnce(ok({ id: "plan-1", title: "P" }));
    fetchMock.mockResolvedValueOnce(ok({ value: [] }));
    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("tok", { query: "match", topN: 9999 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.tasks.length).toBeLessThanOrEqual(__internal.TOP_N_CAP);
  });

  it("falls back to To Do when planner is empty + lists yield matches", async () => {
    // planner returns nothing
    fetchMock.mockResolvedValueOnce(ok({ value: [] }));
    // todo lists
    fetchMock.mockResolvedValueOnce(ok({
      value: [{ id: "list-1", displayName: "Personal" }],
    }));
    // todo tasks
    fetchMock.mockResolvedValueOnce(ok({
      value: [
        { id: "td1", title: "Buy launch swag", body: { content: "" }, status: "notStarted" },
        { id: "td2", title: "unrelated", status: "completed" },
      ],
    }));
    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("tok", { query: "launch swag" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.tasks).toHaveLength(1);
    expect(r.value.tasks[0].id).toBe("td1");
    expect(r.value.tasks[0].plan_or_list_name).toBe("Personal");
    expect(r.value.tasks[0].status).toBe("not_started");
  });

  it("rejects empty query as invalid_input", async () => {
    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("tok", { query: "  " });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("searchProjectTasks - error paths", () => {
  it("returns scope_missing when BOTH planner and todo are 403, never throws", async () => {
    fetchMock
      .mockResolvedValueOnce(err(403, { error: { code: "AccessDenied", message: "nope" } }))
      .mockResolvedValueOnce(err(403, { error: { code: "AccessDenied", message: "nope" } }));
    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("tok", { query: "anything" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("scope_missing");
    // Should report the planner scope (preferred surface) when both fail.
    expect(r.scope).toBe("Tasks.ReadWrite.Shared");
  });

  it("returns partial success when planner 403s but todo responds", async () => {
    // planner 403
    fetchMock.mockResolvedValueOnce(err(403, { error: { code: "AccessDenied", message: "nope" } }));
    // todo lists
    fetchMock.mockResolvedValueOnce(ok({ value: [{ id: "list-1", displayName: "Inbox" }] }));
    // todo tasks
    fetchMock.mockResolvedValueOnce(ok({
      value: [{ id: "x", title: "match this", status: "inProgress" }],
    }));
    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("tok", { query: "match" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.tasks).toHaveLength(1);
    expect(r.value.tasks[0].status).toBe("in_progress");
  });

  it("returns rate_limited when planner returns 429", async () => {
    fetchMock.mockResolvedValueOnce(err(429, {}, { "retry-after": "5" }));
    fetchMock.mockResolvedValueOnce(err(429, {}, { "retry-after": "5" }));
    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("tok", { query: "anything" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("rate_limited");
  });

  it("returns not_connected without a token", async () => {
    const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
    const r = await searchProjectTasks("", { query: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("not_connected");
  });
});

describe("status mapping", () => {
  it("maps planner percentComplete to canonical status values", async () => {
    const { __internal } = await import("@/lib/integrations/microsoft-project");
    expect(__internal.plannerPercentToStatus(0)).toBe("not_started");
    expect(__internal.plannerPercentToStatus(50)).toBe("in_progress");
    expect(__internal.plannerPercentToStatus(100)).toBe("completed");
    expect(__internal.plannerPercentToStatus(undefined)).toBe("unknown");
  });

  it("maps to-do status to canonical status values", async () => {
    const { __internal } = await import("@/lib/integrations/microsoft-project");
    expect(__internal.todoStatusToStatus("notStarted")).toBe("not_started");
    expect(__internal.todoStatusToStatus("inProgress")).toBe("in_progress");
    expect(__internal.todoStatusToStatus("completed")).toBe("completed");
    expect(__internal.todoStatusToStatus("weird")).toBe("unknown");
  });
});
