/**
 * MS Graph sync — tasks worker.
 */
 

export {};

const mockListTasksDelta = jest.fn();
const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/ms-graph/client", () => ({
  listTasksDelta: (...a: any[]) => mockListTasksDelta(...a),
  GraphClientError: class extends Error {
    constructor(public status: number, public code: string, message: string) {
      super(message);
      this.name = "GraphClientError";
    }
  },
  describeGraphError: (err: any) =>
    err && err.name === "GraphClientError"
      ? { code: err.code, status: err.status, message: err.message }
      : { code: "unknown", status: 0, message: (err as Error)?.message },
}));

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  query: (...a: any[]) => mockQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  pool: { query: jest.fn() },
  // activePool() replaced direct pool use so every query is routed to the
  // tenant's database. The mock must expose it or the module under test
  // calls undefined.
  activePool: () => ({ query: jest.fn() }),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [] });
  mockQuery.mockResolvedValue({ rows: [{ id: "u-row" }] });
  mockWriteQuery.mockResolvedValue({ rows: [{ inserted: true }] });
});

describe("tasks sync worker", () => {
  it("creates tasks, writes change_log, saves cursor", async () => {
    mockListTasksDelta.mockResolvedValueOnce({
      items: [
        {
          id: "tsk-1",
          title: "Ship U1",
          status: "notStarted",
          importance: "normal",
          dueDateTime: { dateTime: "2026-05-01T00:00:00Z" },
          body: { content: "details" },
        },
      ],
      nextDeltaLink: JSON.stringify({ "list-1": "https://x/l1" }),
    });

    const { syncUser } = await import("@/lib/ms-graph/sync/tasks");
    const res = await syncUser("u-1");
    expect(res).toMatchObject({ entityType: "tasks", created: 1, updated: 0 });
    const upsertCall = mockWriteQuery.mock.calls.find(([sql]) =>
      /INSERT INTO instinct_ms_tasks/.test(sql),
    );
    expect(upsertCall[1][2]).toBe("Ship U1"); // subject
    expect(upsertCall[1][4]).toBe("notStarted"); // status
  });

  it("delete propagation via @removed", async () => {
    mockListTasksDelta.mockResolvedValueOnce({
      items: [{ id: "t-gone", "@removed": { reason: "deleted" } }],
      nextDeltaLink: JSON.stringify({}),
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "u-row" }] });
    mockWriteQuery
      .mockResolvedValueOnce({ rows: [{ id: "log" }] })
      .mockResolvedValueOnce({ rows: [{ user_id: "u-1" }] });

    const { syncUser } = await import("@/lib/ms-graph/sync/tasks");
    const res = await syncUser("u-1");
    expect(res.deleted).toBe(1);
  });

  it("writeQuery errors bubble as non-throwing 'unknown'", async () => {
    mockListTasksDelta.mockResolvedValueOnce({
      items: [{ id: "t1", title: "x" }],
      nextDeltaLink: JSON.stringify({}),
    });
    mockWriteQuery.mockRejectedValueOnce(new Error("db explode"));
    const { syncUser } = await import("@/lib/ms-graph/sync/tasks");
    const res = await syncUser("u-1");
    expect(res.error).toBe("unknown");
  });
});
