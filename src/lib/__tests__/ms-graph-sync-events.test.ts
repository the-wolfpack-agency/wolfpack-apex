/**
 * MS Graph sync — events worker.
 *
 * Exercises empty-delta, create, update, delete, writeQuery bubble, and
 * scope_missing graceful surface.
 */
 

export {};

const mockListCalendarEventsDelta = jest.fn();
const mockSafeQuery = jest.fn();
const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/ms-graph/client", () => {
  class GraphClientError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
      public retryAfter?: number,
    ) {
      super(message);
      this.name = "GraphClientError";
    }
  }
  return {
    listCalendarEventsDelta: (...a: any[]) => mockListCalendarEventsDelta(...a),
    GraphClientError,
    describeGraphError: (err: any) => {
      if (err && err.name === "GraphClientError") {
        return {
          code: err.code,
          status: err.status,
          retryAfter: err.retryAfter,
          message: err.message,
        };
      }
      return { code: "unknown", status: 0, message: (err as Error)?.message };
    },
  };
});

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
  mockQuery.mockResolvedValue({ rows: [{ id: "uuid-1" }] });
  mockWriteQuery.mockResolvedValue({ rows: [{ inserted: true }] });
});

describe("events sync worker", () => {
  it("empty delta → zero counters, cursor saved, success analytics", async () => {
    mockListCalendarEventsDelta.mockResolvedValueOnce({
      items: [],
      nextDeltaLink: "https://x/delta-empty",
    });
    const { syncUser } = await import("@/lib/ms-graph/sync/events");
    const res = await syncUser("u-1");
    expect(res).toMatchObject({
      entityType: "events",
      created: 0,
      updated: 0,
      deleted: 0,
    });
    expect(res.error).toBeUndefined();
    // Cursor write happened.
    expect(mockWriteQuery.mock.calls.some(([sql]) =>
      /instinct_ms_sync_cursors/.test(sql),
    )).toBe(true);
    expect(mockTrack.mock.calls[0][0]).toBe("ms_sync.user_synced");
  });

  it("create path: new item → created++, change_log 'created'", async () => {
    mockListCalendarEventsDelta.mockResolvedValueOnce({
      items: [
        {
          id: "evt-1",
          subject: "Kickoff",
          start: { dateTime: "2026-05-01T10:00:00Z" },
          end: { dateTime: "2026-05-01T11:00:00Z" },
          isOnlineMeeting: true,
          organizer: { emailAddress: { address: "o@x" } },
          attendees: [{ emailAddress: { address: "a@x" } }],
          lastModifiedDateTime: "2026-05-01T09:00:00Z",
        },
      ],
      nextDeltaLink: "https://x/delta",
    });
    mockWriteQuery
      .mockResolvedValueOnce({ rows: [{ inserted: true }] }) // event upsert
      .mockResolvedValueOnce({ rows: [{ id: "log-1" }] }) // change_log
      .mockResolvedValueOnce({ rows: [{ user_id: "u-1" }] }); // cursor

    const { syncUser } = await import("@/lib/ms-graph/sync/events");
    const res = await syncUser("u-1");
    expect(res.created).toBe(1);
    expect(res.updated).toBe(0);
    expect(res.deleted).toBe(0);
    const changeLogCall = mockWriteQuery.mock.calls.find(([sql]) =>
      /instinct_ms_change_log/.test(sql),
    );
    expect(changeLogCall[1][3]).toBe("created");
  });

  it("update path: existing item (xmax != 0) → updated++", async () => {
    mockListCalendarEventsDelta.mockResolvedValueOnce({
      items: [
        {
          id: "evt-1",
          subject: "Revised",
          start: { dateTime: "2026-05-01T10:00:00Z" },
          end: { dateTime: "2026-05-01T11:00:00Z" },
        },
      ],
      nextDeltaLink: "https://x/delta",
    });
    mockWriteQuery
      .mockResolvedValueOnce({ rows: [{ inserted: false }] })
      .mockResolvedValueOnce({ rows: [{ id: "log-1" }] })
      .mockResolvedValueOnce({ rows: [{ user_id: "u-1" }] });

    const { syncUser } = await import("@/lib/ms-graph/sync/events");
    const res = await syncUser("u-1");
    expect(res.updated).toBe(1);
    expect(res.created).toBe(0);
  });

  it("delete path: @removed item → soft-delete UPDATE runs, deleted++", async () => {
    mockListCalendarEventsDelta.mockResolvedValueOnce({
      items: [{ id: "evt-1", "@removed": { reason: "deleted" } }],
      nextDeltaLink: "https://x/delta",
    });
    // soft-delete returns 1 row via query (NOT writeQuery)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "u-row" }] });
    mockWriteQuery
      .mockResolvedValueOnce({ rows: [{ id: "log-1" }] }) // change_log
      .mockResolvedValueOnce({ rows: [{ user_id: "u-1" }] }); // cursor

    const { syncUser } = await import("@/lib/ms-graph/sync/events");
    const res = await syncUser("u-1");
    expect(res.deleted).toBe(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/UPDATE instinct_ms_events/);
    expect(mockQuery.mock.calls[0][0]).toMatch(/SET deleted_at/);
  });

  it("delete for previously-unseen item is a no-op (no change_log)", async () => {
    mockListCalendarEventsDelta.mockResolvedValueOnce({
      items: [{ id: "unseen", "@removed": { reason: "deleted" } }],
      nextDeltaLink: "https://x/delta",
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // soft-delete found nothing
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ user_id: "u-1" }] });

    const { syncUser } = await import("@/lib/ms-graph/sync/events");
    const res = await syncUser("u-1");
    expect(res.deleted).toBe(0);
    const changeLogCalled = mockWriteQuery.mock.calls.some(([sql]) =>
      /instinct_ms_change_log/.test(sql),
    );
    expect(changeLogCalled).toBe(false);
  });

  it("scope_missing from Graph → graceful typed error, no throw", async () => {
    class GCE extends Error {
      code = "scope_missing";
      status = 403;
      name = "GraphClientError";
    }
    mockListCalendarEventsDelta.mockRejectedValueOnce(new GCE("forbidden"));
    const { syncUser } = await import("@/lib/ms-graph/sync/events");
    const res = await syncUser("u-1");
    expect(res.error).toBe("scope_missing");
    expect(res.created + res.updated + res.deleted).toBe(0);
    expect(
      mockTrack.mock.calls.some(([name]) => name === "ms_sync.scope_missing"),
    ).toBe(true);
  });

  it("writeQuery error during upsert bubbles as 'unknown' error, tracked", async () => {
    mockListCalendarEventsDelta.mockResolvedValueOnce({
      items: [{ id: "evt-1", subject: "x" }],
      nextDeltaLink: "https://x/delta",
    });
    mockWriteQuery.mockRejectedValueOnce(new Error("db down"));
    const { syncUser } = await import("@/lib/ms-graph/sync/events");
    const res = await syncUser("u-1");
    expect(res.error).toBe("unknown");
    expect(mockTrack.mock.calls.some(([name]) => name === "ms_sync.error")).toBe(
      true,
    );
  });

  it("rate_limited from Graph → rate_limited error with retryAfterSec", async () => {
    class GCE extends Error {
      code = "rate_limited";
      status = 429;
      retryAfter = 42;
      name = "GraphClientError";
    }
    mockListCalendarEventsDelta.mockRejectedValueOnce(new GCE("throttle"));
    const { syncUser } = await import("@/lib/ms-graph/sync/events");
    const res = await syncUser("u-1");
    expect(res.error).toBe("rate_limited");
    expect(res.retryAfterSec).toBe(42);
    expect(
      mockTrack.mock.calls.some(([name]) => name === "ms_sync.rate_limited"),
    ).toBe(true);
  });
});
