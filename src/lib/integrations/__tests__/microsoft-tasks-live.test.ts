/**
 * Reading tasks from Microsoft instead of from a mirror nobody fills.
 *
 * WHY THE MIRROR IS BEING LEFT BEHIND. instinct_ms_tasks has never held a row
 * in production. The sync worker is well built and nothing schedules it; its
 * own docstring asks for a poller that was never written. Every read returned
 * [] and the assistant reported that as "You have no open tasks. Nice."
 *
 * Writing the missing poller would mean maintaining a copy of the client's task
 * list in our database in order to answer a question Microsoft can answer
 * directly. Reading live removes the sync, the cursor, the staleness question
 * and the copy.
 *
 * WHAT THESE PROVE. Graph has no "all my tasks" endpoint, so this fans out
 * across lists, and the fan-out is where the interesting failures live: one
 * list down, every list down, an account with no lists at all. Each is a
 * different sentence and only one of them is "you have no tasks".
 */
import { listOpenTasksLive } from "@/lib/integrations/microsoft-tasks";

const mockResolveToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockResolveToken(...a),
}));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: () => undefined }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: () => undefined }));

const realFetch = global.fetch;
const fetchMock = jest.fn();

beforeAll(() => {
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  mockResolveToken.mockResolvedValue({ accessToken: "tok", userEmail: "a@b.co" });
});

function ok(data: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}
function err(status: number) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve({ error: { message: "no" } }),
    text: () => Promise.resolve("{}"),
  };
}

function task(id: string, title: string, dueAt?: string) {
  return {
    id,
    title,
    status: "notStarted",
    importance: "normal",
    dueDateTime: dueAt ? { dateTime: dueAt, timeZone: "UTC" } : null,
  };
}

describe("gathering tasks across lists", () => {
  it("returns the tasks Microsoft actually holds", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ value: [{ id: "L1", displayName: "Tasks" }] }))
      .mockResolvedValueOnce(ok({ value: [task("t1", "Call the dealer")] }));

    const r = await listOpenTasksLive("u1");
    if (!r.ok) throw new Error(`expected tasks, got ${r.reason}`);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0].title).toBe("Call the dealer");
    expect(r.tasks[0].msTaskId).toBe("t1");
  });

  /* Somebody reads a to-do list by what is due first, not by the order Graph
     happened to return their lists in. */
  it("orders by due date, undated last", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ value: [{ id: "L1", displayName: "A" }, { id: "L2", displayName: "B" }] }),
      )
      .mockResolvedValueOnce(ok({ value: [task("t1", "No date"), task("t2", "Later", "2026-09-10T00:00:00Z")] }))
      .mockResolvedValueOnce(ok({ value: [task("t3", "Sooner", "2026-09-01T00:00:00Z")] }));

    const r = await listOpenTasksLive("u1");
    if (!r.ok) throw new Error("expected tasks");
    expect(r.tasks.map((t) => t.title)).toEqual(["Sooner", "Later", "No date"]);
  });

  /* An account with no lists genuinely holds nothing, and that is a readable
     answer rather than a failure. */
  it("reports an account with no lists as empty, not as broken", async () => {
    fetchMock.mockResolvedValueOnce(ok({ value: [] }));
    expect(await listOpenTasksLive("u1")).toEqual({ ok: true, tasks: [] });
  });

  it("respects the caller's limit", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ value: [{ id: "L1", displayName: "Tasks" }] }))
      .mockResolvedValueOnce(
        ok({ value: [task("a", "1"), task("b", "2"), task("c", "3")] }),
      );
    const r = await listOpenTasksLive("u1", { limit: 2 });
    if (!r.ok) throw new Error("expected tasks");
    expect(r.tasks).toHaveLength(2);
  });
});

describe("failures name themselves rather than reading as an empty list", () => {
  it.each([
    [401, "not_connected"],
    [403, "scope_missing"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ])("maps HTTP %i on the list call to %s", async (status, reason) => {
    fetchMock.mockResolvedValue(err(status));
    expect(await listOpenTasksLive("u1")).toEqual({ ok: false, reason });
  });

  /* ONE LIST DOWN IS NOT A FAILURE. Refusing to answer because one list of
     several was briefly unavailable would be worse than a slightly short list,
     and the reader still gets the tasks we could see. */
  it("still answers when one list of two fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok({ value: [{ id: "L1", displayName: "A" }, { id: "L2", displayName: "B" }] }),
      )
      .mockResolvedValueOnce(ok({ value: [task("t1", "Survivor")] }))
      .mockResolvedValueOnce(err(500));

    const r = await listOpenTasksLive("u1");
    if (!r.ok) throw new Error("expected a partial answer");
    expect(r.tasks.map((t) => t.title)).toEqual(["Survivor"]);
  });

  /* EVERY LIST DOWN IS. Returning [] here would say "you have no tasks" to
     somebody whose lists we could not read at all, which is the exact bug this
     whole change exists to remove. */
  it("reports a failure when every list fails", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ value: [{ id: "L1", displayName: "A" }] }))
      .mockResolvedValueOnce(err(500));

    const r = await listOpenTasksLive("u1");
    expect(r.ok).toBe(false);
  });
});

describe("nothing of theirs is written down", () => {
  /* The point of reading live. If this ever starts writing to the mirror it
     has quietly become the thing it replaced. */
  it("does not write to the database", async () => {
    const { query } = jest.requireMock("@/lib/db") as { query: jest.Mock };
    fetchMock
      .mockResolvedValueOnce(ok({ value: [{ id: "L1", displayName: "Tasks" }] }))
      .mockResolvedValueOnce(ok({ value: [task("t1", "Anything")] }));

    await listOpenTasksLive("u1");
    const writes = query.mock.calls.filter(([sql]) =>
      /INSERT|UPDATE|DELETE/i.test(String(sql)),
    );
    expect(writes).toEqual([]);
  });
});
