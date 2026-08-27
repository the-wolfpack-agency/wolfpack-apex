/**
 * The reader that joins the three systems, and what it does when one lies.
 *
 * THE FAILURE THIS FILE IS BUILT AROUND. `listUpcomingMeetings` catches a Graph
 * failure and returns `[]`. That is a reasonable thing for a dashboard widget
 * to do and a disastrous thing for a status answer to trust: an empty array
 * from a dead token is indistinguishable from a genuinely clear diary, and the
 * difference is "you have no meetings booked" versus "I could not look". This
 * codebase has already shipped that exact bug once, when 354 failed Graph calls
 * were cached and read back to users as "you have never emailed this person".
 *
 * So the calendar leg checks the connection SEPARATELY, and the test below
 * proves it by making the meeting list return empty while the connection is
 * fine, and then making the connection fail while the meeting list would have
 * returned rows. Those two cases must not produce the same reading.
 */

const mockListUpcomingMeetings = jest.fn();
const mockGetConnectionStatus = jest.fn();
const mockListDocuments = jest.fn();
const mockListCachedTasks = jest.fn();

jest.mock("@/lib/meetings/upcoming", () => ({
  listUpcomingMeetings: (...a: unknown[]) => mockListUpcomingMeetings(...a),
}));
jest.mock("@/lib/microsoft-graph", () => ({
  getConnectionStatus: (...a: unknown[]) => mockGetConnectionStatus(...a),
}));
jest.mock("@/lib/brain/repo", () => ({
  listDocuments: (...a: unknown[]) => mockListDocuments(...a),
}));
jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTasks: (...a: unknown[]) => mockListCachedTasks(...a),
}));

import { readPilotStatus, DEFAULT_WINDOW_DAYS } from "@/lib/pilot/status";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const OPTS = { userId: "u1", userRole: "cto", nowMs: NOW };

function graphMeeting(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    subject: "Pilot review",
    start: new Date(NOW + 2 * DAY).toISOString(),
    end: new Date(NOW + 2 * DAY + 3600_000).toISOString(),
    location: "Teams",
    attendees: ["client@example.com"],
    isOnlineMeeting: true,
    minutesUntil: 2880,
    inProgress: false,
    isOutOfOffice: false,
    ...over,
  };
}

function brainDoc(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    filename: "SOW.pdf",
    created_at: new Date(NOW - 2 * DAY).toISOString(),
    status: "indexed",
    chunk_count: 12,
    ...over,
  };
}

function msTask(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    title: "Draft the report",
    status: "notStarted",
    dueAt: null,
    completedAt: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConnectionStatus.mockResolvedValue({ connected: true, mode: "live" });
  mockListUpcomingMeetings.mockResolvedValue([graphMeeting()]);
  mockListDocuments.mockResolvedValue([brainDoc()]);
  mockListCachedTasks.mockResolvedValue({ tasks: [msTask()], nextCursor: null });
});

describe("the happy join", () => {
  it("reads all three systems and marks each ok", async () => {
    const r = await readPilotStatus(OPTS);
    expect(r.calendar.state).toBe("ok");
    expect(r.documents.state).toBe("ok");
    expect(r.tasks.state).toBe("ok");
    expect(r.calendar.items).toHaveLength(1);
    expect(r.documents.items).toHaveLength(1);
    expect(r.tasks.items).toHaveLength(1);
    expect(r.windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(r.takenAt).toBe(new Date(NOW).toISOString());
  });

  it("reads the three legs concurrently rather than in series", async () => {
    /* Not a performance nicety. A serial join makes the slowest integration
       set the latency of every status answer, and this one is on the demo
       path. Proven by resolving all three only once all three have been
       called, which deadlocks if they are awaited in sequence. */
    let called = 0;
    const gate = new Promise<void>((resolve) => {
      const bump = () => {
        if (++called === 3) resolve();
      };
      mockGetConnectionStatus.mockImplementation(async () => {
        bump();
        await gate;
        return { connected: true, mode: "live" };
      });
      mockListDocuments.mockImplementation(async () => {
        bump();
        await gate;
        return [brainDoc()];
      });
      mockListCachedTasks.mockImplementation(async () => {
        bump();
        await gate;
        return { tasks: [], nextCursor: null };
      });
    });
    await expect(readPilotStatus(OPTS)).resolves.toBeDefined();
  });
});

describe("an empty source and an unreadable source are different readings", () => {
  /* THE POINT OF THE WHOLE MODULE. */
  it("a clear diary is ok+empty, a failed read is unavailable", async () => {
    mockListUpcomingMeetings.mockResolvedValue([]);
    const clear = await readPilotStatus(OPTS);
    expect(clear.calendar.state).toBe("ok");
    expect(clear.calendar.items).toHaveLength(0);
    expect(clear.calendar.detail).toBeNull();

    mockListUpcomingMeetings.mockRejectedValue(new Error("Graph 503"));
    const broken = await readPilotStatus(OPTS);
    expect(broken.calendar.state).toBe("unavailable");
    expect(broken.calendar.detail).toContain("Graph 503");
  });

  it("does not trust an empty meeting list when the account is not connected", async () => {
    /* listUpcomingMeetings swallows its own failure into []. Believing it
       here would report a clear diary to somebody with an expired token. */
    mockGetConnectionStatus.mockResolvedValue({ connected: false, mode: "live" });
    mockListUpcomingMeetings.mockResolvedValue([]);
    const r = await readPilotStatus(OPTS);
    expect(r.calendar.state).toBe("not_connected");
    expect(r.calendar.detail).toMatch(/not connected/i);
    /* And it did not even bother asking Graph for meetings. */
    expect(mockListUpcomingMeetings).not.toHaveBeenCalled();
  });

  it("marks the calendar unavailable when the connection check itself throws", async () => {
    mockGetConnectionStatus.mockRejectedValue(new Error("db down"));
    const r = await readPilotStatus(OPTS);
    expect(r.calendar.state).toBe("unavailable");
    expect(r.calendar.detail).toContain("db down");
  });

  it("marks the Brain unavailable when listDocuments throws", async () => {
    mockListDocuments.mockRejectedValue(new Error("relation does not exist"));
    const r = await readPilotStatus(OPTS);
    expect(r.documents.state).toBe("unavailable");
    expect(r.documents.detail).toContain("relation does not exist");
    /* And the other two legs still answered. One dead source degrades the
       view; it does not take the answer down. */
    expect(r.calendar.state).toBe("ok");
    expect(r.tasks.state).toBe("ok");
  });

  it("marks tasks unavailable when the task store throws", async () => {
    mockListCachedTasks.mockRejectedValue(new Error("timeout"));
    const r = await readPilotStatus(OPTS);
    expect(r.tasks.state).toBe("unavailable");
    expect(r.calendar.state).toBe("ok");
    expect(r.documents.state).toBe("ok");
  });

  it("survives all three failing at once", async () => {
    mockGetConnectionStatus.mockRejectedValue(new Error("a"));
    mockListDocuments.mockRejectedValue(new Error("b"));
    mockListCachedTasks.mockRejectedValue(new Error("c"));
    const r = await readPilotStatus(OPTS);
    expect([r.calendar.state, r.documents.state, r.tasks.state]).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("the window", () => {
  it("keeps documents inside the window and drops older ones", async () => {
    mockListDocuments.mockResolvedValue([
      brainDoc({ id: "recent", created_at: new Date(NOW - 2 * DAY).toISOString() }),
      brainDoc({ id: "old", created_at: new Date(NOW - 40 * DAY).toISOString() }),
    ]);
    const r = await readPilotStatus(OPTS);
    expect(r.documents.items.map((d) => d.id)).toEqual(["recent"]);
  });

  it("ignores a document with an unparseable created_at rather than counting it", async () => {
    mockListDocuments.mockResolvedValue([brainDoc({ id: "bad", created_at: "not-a-date" })]);
    const r = await readPilotStatus(OPTS);
    expect(r.documents.items).toHaveLength(0);
  });

  it("counts only work closed inside the window as momentum", async () => {
    mockListCachedTasks.mockResolvedValue({
      tasks: [
        msTask({ id: "recent", status: "completed", completedAt: new Date(NOW - 1 * DAY).toISOString() }),
        msTask({ id: "ancient", status: "completed", completedAt: new Date(NOW - 90 * DAY).toISOString() }),
        msTask({ id: "open" }),
      ],
      nextCursor: null,
    });
    const r = await readPilotStatus(OPTS);
    expect(r.tasks.items.map((t) => t.id).sort()).toEqual(["open", "recent"]);
  });

  it("honours a caller-supplied window", async () => {
    mockListDocuments.mockResolvedValue([
      brainDoc({ id: "d20", created_at: new Date(NOW - 20 * DAY).toISOString() }),
    ]);
    expect((await readPilotStatus(OPTS)).documents.items).toHaveLength(0);
    expect((await readPilotStatus({ ...OPTS, windowDays: 30 })).documents.items).toHaveLength(1);
  });
});

describe("field derivation", () => {
  it("marks a document answerable only when indexed with chunks", async () => {
    mockListDocuments.mockResolvedValue([
      brainDoc({ id: "ready", status: "indexed", chunk_count: 5 }),
      brainDoc({ id: "queued", status: "queued", chunk_count: 0 }),
      /* THE SILENT ONE: status says indexed, nothing was actually stored. */
      brainDoc({ id: "hollow", status: "indexed", chunk_count: 0 }),
    ]);
    const r = await readPilotStatus(OPTS);
    const byId = Object.fromEntries(r.documents.items.map((d) => [d.id, d.indexed]));
    expect(byId).toEqual({ ready: true, queued: false, hollow: false });
  });

  it("computes overdue against the injected clock, not the wall clock", async () => {
    mockListCachedTasks.mockResolvedValue({
      tasks: [
        msTask({ id: "late", dueAt: new Date(NOW - 1 * DAY).toISOString() }),
        msTask({ id: "soon", dueAt: new Date(NOW + 1 * DAY).toISOString() }),
        msTask({ id: "undated", dueAt: null }),
      ],
      nextCursor: null,
    });
    const r = await readPilotStatus(OPTS);
    const byId = Object.fromEntries(r.tasks.items.map((t) => [t.id, t.overdue]));
    expect(byId).toEqual({ late: true, soon: false, undated: false });
  });

  it("never marks a completed task overdue", async () => {
    mockListCachedTasks.mockResolvedValue({
      tasks: [
        msTask({
          id: "done-late",
          status: "completed",
          dueAt: new Date(NOW - 5 * DAY).toISOString(),
          completedAt: new Date(NOW - 1 * DAY).toISOString(),
        }),
      ],
      nextCursor: null,
    });
    const r = await readPilotStatus(OPTS);
    expect(r.tasks.items[0]).toMatchObject({ completed: true, overdue: false });
  });

  it("drops out-of-office blocks from the checkpoint list", async () => {
    /* A week of PTO is not a pilot checkpoint, and counting it as one would
       put "next checkpoint: Vacation" in front of a client. */
    mockListUpcomingMeetings.mockResolvedValue([
      graphMeeting({ id: "ooo", subject: "Vacation", isOutOfOffice: true }),
      graphMeeting({ id: "real", subject: "Pilot review" }),
    ]);
    const r = await readPilotStatus(OPTS);
    expect(r.calendar.items.map((m) => m.id)).toEqual(["real"]);
  });

  it("reads for the owner when an agent is acting on somebody's behalf", async () => {
    await readPilotStatus({ ...OPTS, userId: "owner-1" });
    expect(mockGetConnectionStatus).toHaveBeenCalledWith("owner-1");
    expect(mockListCachedTasks).toHaveBeenCalledWith("owner-1", expect.anything());
  });
});
