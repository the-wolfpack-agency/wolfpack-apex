/**
 * MS Graph unified sync dispatcher — partial-failure isolation.
 *
 * Verifies: when one worker errors (e.g. scope_missing), the remaining
 * workers still run, the aggregate `failedEntityTypes` surfaces the
 * failure, and counters from successful workers propagate correctly.
 */
 

export {};

const events = jest.fn();
const tasks = jest.fn();
const messages = jest.fn();
const contacts = jest.fn();
const files = jest.fn();

jest.mock("@/lib/ms-graph/sync/events", () => ({ syncUser: (...a: any[]) => events(...a) }));
jest.mock("@/lib/ms-graph/sync/tasks", () => ({ syncUser: (...a: any[]) => tasks(...a) }));
jest.mock("@/lib/ms-graph/sync/messages", () => ({ syncUser: (...a: any[]) => messages(...a) }));
jest.mock("@/lib/ms-graph/sync/contacts", () => ({ syncUser: (...a: any[]) => contacts(...a) }));
jest.mock("@/lib/ms-graph/sync/files", () => ({ syncUser: (...a: any[]) => files(...a) }));

beforeEach(() => {
  jest.clearAllMocks();
});

function ok(entity: string, c = 1, u = 0, d = 0) {
  return Promise.resolve({
    entityType: entity,
    created: c,
    updated: u,
    deleted: d,
    durationMs: 10,
  });
}

describe("syncAllEntities dispatcher", () => {
  it("runs every worker and aggregates counters", async () => {
    events.mockReturnValue(ok("events", 1, 0, 0));
    tasks.mockReturnValue(ok("tasks", 2, 3, 0));
    messages.mockReturnValue(ok("messages", 0, 0, 0));
    contacts.mockReturnValue(ok("contacts", 5, 0, 0));
    files.mockReturnValue(ok("files", 0, 0, 1));

    const { syncAllEntities } = await import("@/lib/ms-graph/sync");
    const res = await syncAllEntities("u-1");
    expect(res.totalCreated).toBe(8);
    expect(res.totalUpdated).toBe(3);
    expect(res.totalDeleted).toBe(1);
    expect(res.results).toHaveLength(5);
    expect(res.failedEntityTypes).toEqual([]);
  });

  it("partial failure: one worker 403 — others still run, failedEntityTypes reports it", async () => {
    events.mockReturnValue(ok("events", 1));
    tasks.mockReturnValue(
      Promise.resolve({
        entityType: "tasks",
        created: 0,
        updated: 0,
        deleted: 0,
        durationMs: 5,
        error: "scope_missing",
      }),
    );
    messages.mockReturnValue(ok("messages", 2));
    contacts.mockReturnValue(ok("contacts", 3));
    files.mockReturnValue(ok("files", 0, 0, 1));

    const { syncAllEntities } = await import("@/lib/ms-graph/sync");
    const res = await syncAllEntities("u-1");
    // All 5 still ran.
    expect(events).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledTimes(1);
    expect(contacts).toHaveBeenCalledTimes(1);
    expect(files).toHaveBeenCalledTimes(1);
    expect(res.failedEntityTypes).toEqual(["tasks"]);
    // Aggregate only counts successful workers' changes, but failing worker
    // contributes zeros (not NaN).
    expect(res.totalCreated).toBe(1 + 0 + 2 + 3 + 0);
    expect(res.totalDeleted).toBe(1);
  });

  it("worker that throws (bug, not Graph error) is caught and surfaced as 'unknown'", async () => {
    events.mockReturnValue(ok("events", 1));
    tasks.mockImplementation(() => {
      throw new Error("sync worker bug");
    });
    messages.mockReturnValue(ok("messages", 1));
    contacts.mockReturnValue(ok("contacts", 1));
    files.mockReturnValue(ok("files", 1));

    const { syncAllEntities } = await import("@/lib/ms-graph/sync");
    const res = await syncAllEntities("u-1");
    expect(res.failedEntityTypes).toEqual(["tasks"]);
    const tasksResult = res.results.find((r) => r.entityType === "tasks");
    expect(tasksResult?.error).toBe("unknown");
    expect(res.totalCreated).toBe(4); // events + messages + contacts + files
  });

  it("only: [] subset runs just those workers", async () => {
    events.mockReturnValue(ok("events", 7));
    tasks.mockReturnValue(ok("tasks", 99)); // should NOT be called
    messages.mockReturnValue(ok("messages", 99));
    contacts.mockReturnValue(ok("contacts", 99));
    files.mockReturnValue(ok("files", 99));

    const { syncAllEntities } = await import("@/lib/ms-graph/sync");
    const res = await syncAllEntities("u-1", { only: ["events"] });
    expect(events).toHaveBeenCalledTimes(1);
    expect(tasks).not.toHaveBeenCalled();
    expect(res.totalCreated).toBe(7);
    expect(res.results).toHaveLength(1);
  });
});
