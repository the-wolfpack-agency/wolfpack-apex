/**
 * computeWeeklyReview tests — MS Graph calendar/email + MS Tasks cache
 * mocked. Covers counts, slip integration, week boundary, and
 * prior-week tasks being excluded from the current week's "opened".
 */
 

const mockFetchCalendar = jest.fn();
const mockFetchEmails = jest.fn();
const mockListCachedTasks = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...args: any[]) => mockFetchCalendar(...args),
  fetchRecentEmails: (...args: any[]) => mockFetchEmails(...args),
}));

jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTasks: (...args: any[]) => mockListCachedTasks(...args),
}));

import { computeWeeklyReview, mondayOf } from "@/lib/review/weekly";

const DAY = 24 * 60 * 60 * 1000;

function task(overrides: Record<string, unknown>) {
  return {
    id: overrides.id ?? `t-${Math.random()}`,
    msTaskId: "ms",
    userId: "u1",
    listId: "list",
    title: overrides.title ?? "T",
    body: null,
    status: overrides.status ?? "notStarted",
    importance: "normal",
    dueAt: overrides.dueAt ?? null,
    completedAt: overrides.completedAt ?? null,
    createdAt: overrides.createdAt ?? new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
    etag: null,
    syncedAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

beforeEach(() => {
  mockFetchCalendar.mockReset();
  mockFetchEmails.mockReset();
  mockListCachedTasks.mockReset();
});

describe("mondayOf", () => {
  test("snaps any day in the week to the Monday-00:00 UTC of that week", () => {
    // 2026-04-21 is a Tuesday (UTC). Monday of that week is 2026-04-20.
    const tue = new Date("2026-04-21T15:30:00Z");
    expect(mondayOf(tue).toISOString()).toBe("2026-04-20T00:00:00.000Z");
  });

  test("Sunday snaps to the PRIOR Monday, not the next", () => {
    // 2026-04-26 is Sunday. Monday of that week is 2026-04-20.
    const sun = new Date("2026-04-26T23:59:00Z");
    expect(mondayOf(sun).toISOString()).toBe("2026-04-20T00:00:00.000Z");
  });

  test("Monday of itself returns the same Monday at 00:00 UTC", () => {
    const mon = new Date("2026-04-20T08:00:00Z");
    expect(mondayOf(mon).toISOString()).toBe("2026-04-20T00:00:00.000Z");
  });
});

describe("computeWeeklyReview", () => {
  const weekStart = new Date("2026-04-20T00:00:00Z"); // Monday
  const weekStartMs = weekStart.getTime();

  test("counts meetings, tasks closed/opened, unanswered-flagged emails inside the window", async () => {
    mockFetchCalendar.mockResolvedValue([
      { id: "m1", subject: "A", start: new Date(weekStartMs + DAY).toISOString(), end: new Date(weekStartMs + DAY + 3600_000).toISOString(), location: "", attendees: [], isOnlineMeeting: false },
      { id: "m2", subject: "B", start: new Date(weekStartMs + 3 * DAY).toISOString(), end: new Date(weekStartMs + 3 * DAY + 3600_000).toISOString(), location: "", attendees: [], isOnlineMeeting: false },
      // Outside the window (next week) — must not count
      { id: "m3", subject: "C", start: new Date(weekStartMs + 8 * DAY).toISOString(), end: new Date(weekStartMs + 8 * DAY + 3600_000).toISOString(), location: "", attendees: [], isOnlineMeeting: false },
    ]);

    mockFetchEmails.mockResolvedValue([
      // High importance + unread + in window → counts
      { id: "e1", subject: "!", from: "X", fromEmail: "x@x", receivedDateTime: new Date(weekStartMs + 2 * DAY).toISOString(), bodyPreview: "", isRead: false, importance: "high" },
      // High but read → doesn't count
      { id: "e2", subject: "!", from: "X", fromEmail: "x@x", receivedDateTime: new Date(weekStartMs + 2 * DAY).toISOString(), bodyPreview: "", isRead: true, importance: "high" },
      // Normal importance → doesn't count
      { id: "e3", subject: "ok", from: "X", fromEmail: "x@x", receivedDateTime: new Date(weekStartMs + 2 * DAY).toISOString(), bodyPreview: "", isRead: false, importance: "normal" },
      // High + unread but OUTSIDE window → doesn't count
      { id: "e4", subject: "!", from: "X", fromEmail: "x@x", receivedDateTime: new Date(weekStartMs + 10 * DAY).toISOString(), bodyPreview: "", isRead: false, importance: "high" },
    ]);

    mockListCachedTasks.mockResolvedValue({
      tasks: [
        task({ id: "closed-in-week", status: "completed", createdAt: new Date(weekStartMs - 5 * DAY).toISOString(), completedAt: new Date(weekStartMs + DAY).toISOString() }),
        task({ id: "opened-in-week", status: "notStarted", createdAt: new Date(weekStartMs + 2 * DAY).toISOString() }),
        task({ id: "closed-prior-week", status: "completed", createdAt: new Date(weekStartMs - 10 * DAY).toISOString(), completedAt: new Date(weekStartMs - 2 * DAY).toISOString() }),
      ],
      nextCursor: null,
    });

    const review = await computeWeeklyReview("u1", weekStart);
    expect(review.weekStart).toBe("2026-04-20T00:00:00.000Z");
    expect(review.weekEnd).toBe("2026-04-27T00:00:00.000Z");
    expect(review.meetingsAttended).toBe(2);
    expect(review.tasksClosed).toBe(1);
    expect(review.tasksOpened).toBe(1);
    expect(review.unansweredFlagged).toBe(1);
  });

  test("integrates detectSlips — overdue tasks appear in slips with reason 'overdue'", async () => {
    const now = new Date();
    mockFetchCalendar.mockResolvedValue([]);
    mockFetchEmails.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({
      tasks: [
        task({
          id: "slip-1",
          title: "Overdue thing",
          status: "notStarted",
          dueAt: new Date(now.getTime() - DAY).toISOString(),
          createdAt: new Date(now.getTime() - 10 * DAY).toISOString(),
        }),
      ],
      nextCursor: null,
    });

    const review = await computeWeeklyReview("u1", weekStart);
    expect(review.slips.length).toBe(1);
    expect(review.slips[0].id).toBe("slip-1");
    expect(review.slips[0].reason).toBe("overdue");
    expect(review.slips[0].title).toBe("Overdue thing");
  });

  test("snaps a non-Monday weekStart to the Monday of that week", async () => {
    mockFetchCalendar.mockResolvedValue([]);
    mockFetchEmails.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({ tasks: [], nextCursor: null });

    const wed = new Date("2026-04-22T09:00:00Z");
    const review = await computeWeeklyReview("u1", wed);
    expect(review.weekStart).toBe("2026-04-20T00:00:00.000Z");
    expect(review.weekEnd).toBe("2026-04-27T00:00:00.000Z");
  });

  test("prior-week tasks are NOT counted as 'tasks opened this week'", async () => {
    mockFetchCalendar.mockResolvedValue([]);
    mockFetchEmails.mockResolvedValue([]);
    mockListCachedTasks.mockResolvedValue({
      tasks: [
        task({ id: "prior", status: "notStarted", createdAt: new Date(weekStartMs - 3 * DAY).toISOString() }),
        task({ id: "current", status: "notStarted", createdAt: new Date(weekStartMs + 2 * DAY).toISOString() }),
      ],
      nextCursor: null,
    });

    const review = await computeWeeklyReview("u1", weekStart);
    expect(review.tasksOpened).toBe(1);
  });

  test("graceful when Graph calls fail — returns zeros, never throws", async () => {
    mockFetchCalendar.mockRejectedValue(new Error("graph down"));
    mockFetchEmails.mockRejectedValue(new Error("graph down"));
    mockListCachedTasks.mockRejectedValue(new Error("db down"));

    const review = await computeWeeklyReview("u1", weekStart);
    expect(review.meetingsAttended).toBe(0);
    expect(review.tasksClosed).toBe(0);
    expect(review.tasksOpened).toBe(0);
    expect(review.unansweredFlagged).toBe(0);
    expect(review.slips).toEqual([]);
  });
});
