/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  computeInsights,
  focusTimeInsight,
  followUpGapInsight,
  meetingLoadInsight,
  overdueTasksInsight,
  recurringAttendeesInsight,
  sortBySeverity,
  taskChurnInsight,
} from "@/lib/ms-insights/insights";

const NOW = Date.parse("2026-04-21T14:00:00Z");
const DAY = 24 * 60 * 60_000;

function ev(offsetMin: number, durMin: number, attendees: string[] = []): any {
  return {
    id: `e-${offsetMin}`,
    subject: "x",
    start: new Date(NOW + offsetMin * 60_000).toISOString(),
    end: new Date(NOW + (offsetMin + durMin) * 60_000).toISOString(),
    location: "",
    attendees,
    isOnlineMeeting: false,
  };
}

function task(overrides: any = {}): any {
  return {
    id: "t",
    msTaskId: "mt",
    userId: "u",
    listId: "L",
    title: "t",
    body: null,
    status: "notStarted",
    importance: "normal",
    dueAt: null,
    completedAt: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    etag: null,
    syncedAt: "",
    payload: {},
    ...overrides,
  };
}

function email(overrides: any = {}): any {
  return {
    id: "m",
    subject: "s",
    from: "X",
    fromEmail: "x@y.co",
    receivedDateTime: new Date(NOW - 60_000).toISOString(),
    bodyPreview: "",
    isRead: false,
    importance: "normal",
    ...overrides,
  };
}

describe("meetingLoadInsight", () => {
  test("flags risk when today's meeting hours >= 6", () => {
    const events = [ev(-60, 240), ev(180, 180)]; // 7h
    const i = meetingLoadInsight(events, NOW);
    expect(i.severity).toBe("risk");
    expect(i.metric).toBe(7);
  });
  test("ok with light load", () => {
    const i = meetingLoadInsight([ev(-60, 30)], NOW);
    expect(i.severity).toBe("ok");
  });
  test("ok + empty headline when no meetings today", () => {
    const i = meetingLoadInsight([], NOW);
    expect(i.headline).toMatch(/No meetings today/);
  });
});

describe("focusTimeInsight", () => {
  test("returns full work day gap when calendar is empty", () => {
    const i = focusTimeInsight([], NOW);
    expect(i.metric).toBeGreaterThanOrEqual(60);
    expect(i.severity).toBe("ok");
  });
  test("flags risk when calendar is fully blocked", () => {
    // Cover the full day in UTC so any local-tz work-day window is filled.
    const dayStartUtc = Date.parse("2026-04-21T00:00:00Z");
    const events = [{
      id: "all-day",
      subject: "blocked",
      start: new Date(dayStartUtc).toISOString(),
      end: new Date(dayStartUtc + 24 * 60 * 60_000 - 60_000).toISOString(),
      location: "",
      attendees: [],
      isOnlineMeeting: false,
    }];
    const i = focusTimeInsight(events as any, NOW);
    expect(i.severity).toBe("risk");
    expect(i.metric).toBe(0);
  });
});

describe("taskChurnInsight", () => {
  test("warns when closing less than half of opened in the window", () => {
    const tasks = [
      task({ id: "1", createdAt: new Date(NOW - 2 * DAY).toISOString() }),
      task({ id: "2", createdAt: new Date(NOW - 2 * DAY).toISOString() }),
      task({ id: "3", createdAt: new Date(NOW - 2 * DAY).toISOString() }),
      task({
        id: "4",
        createdAt: new Date(NOW - 2 * DAY).toISOString(),
        completedAt: new Date(NOW - 1 * DAY).toISOString(),
      }),
    ];
    const i = taskChurnInsight(tasks, NOW, 7);
    expect(i.severity).toBe("warn");
    expect(i.metric).toBeCloseTo(0.25, 2);
  });
  test("info + null metric when no activity", () => {
    const i = taskChurnInsight([], NOW, 7);
    expect(i.metric).toBeNull();
  });
});

describe("overdueTasksInsight", () => {
  test("risk when oldest overdue is >= 7 days", () => {
    const tasks = [
      task({ dueAt: new Date(NOW - 10 * DAY).toISOString() }),
      task({ dueAt: new Date(NOW - 1 * DAY).toISOString() }),
    ];
    const i = overdueTasksInsight(tasks, NOW);
    expect(i.severity).toBe("risk");
    expect(i.metric).toBe(2);
    expect(i.cta).toBeDefined();
  });
  test("ok when nothing overdue", () => {
    const i = overdueTasksInsight([task({ dueAt: new Date(NOW + DAY).toISOString() })], NOW);
    expect(i.severity).toBe("ok");
    expect(i.metric).toBe(0);
  });
  test("excludes completed tasks", () => {
    const i = overdueTasksInsight(
      [task({ dueAt: new Date(NOW - 5 * DAY).toISOString(), status: "completed" })],
      NOW,
    );
    expect(i.metric).toBe(0);
  });
});

describe("followUpGapInsight", () => {
  test("counts unread senders in last 48h", () => {
    const emails = [
      email({ fromEmail: "a@x.co", isRead: false }),
      email({ fromEmail: "b@x.co", isRead: false }),
      email({ fromEmail: "a@x.co", isRead: false }), // dedup
      email({ fromEmail: "c@x.co", isRead: true }), // read, skip
      email({
        fromEmail: "d@x.co",
        isRead: false,
        receivedDateTime: new Date(NOW - 3 * DAY).toISOString(),
      }), // too old
    ];
    const i = followUpGapInsight(emails, NOW);
    expect(i.metric).toBe(2);
  });
  test("ok with empty inbox", () => {
    expect(followUpGapInsight([], NOW).severity).toBe("ok");
  });
});

describe("recurringAttendeesInsight", () => {
  test("picks top attendee", () => {
    const events = [
      ev(-DAY / 60_000, 30, ["a@x.co"]),
      ev(-2 * DAY / 60_000, 30, ["a@x.co", "b@x.co"]),
      ev(-3 * DAY / 60_000, 30, ["a@x.co"]),
    ];
    const i = recurringAttendeesInsight(events, NOW, 7);
    expect(i.headline).toContain("a@x.co");
    expect(i.metric).toBe(3);
  });
  test("info + 0 when no recurring contacts", () => {
    const i = recurringAttendeesInsight([], NOW, 7);
    expect(i.metric).toBe(0);
  });
  // Regression: fetchLiveCalendarEvents maps attendees to display NAMES
  // first, falling back to address. An earlier filter required
  // a.includes("@") and silently dropped every name-only attendee,
  // producing "No recurring meeting contacts" on live calendars.
  test("counts name-only attendees (no @) — live Graph shape", () => {
    const events = [
      ev(-DAY / 60_000, 30, ["Nick Hoxsie", "Sarah Chen"]),
      ev(-2 * DAY / 60_000, 30, ["Nick Hoxsie"]),
      ev(-3 * DAY / 60_000, 30, ["Nick Hoxsie", "Jorge Colon"]),
    ];
    const i = recurringAttendeesInsight(events, NOW, 7);
    expect(i.headline).toContain("Nick Hoxsie");
    expect(i.metric).toBe(3);
    expect(i.detail).toMatch(/Nick Hoxsie \(3\)/);
  });
  // Regression: dedupe key was lowercased, then displayed verbatim.
  // The UI showed "nick hoxsie" instead of "Nick Hoxsie".
  test("preserves original casing for display while deduping case-insensitively", () => {
    const events = [
      ev(-DAY / 60_000, 30, ["Nick Hoxsie"]),
      ev(-2 * DAY / 60_000, 30, ["nick hoxsie"]), // same person, different case
      ev(-3 * DAY / 60_000, 30, ["NICK HOXSIE"]),
    ];
    const i = recurringAttendeesInsight(events, NOW, 7);
    expect(i.metric).toBe(3);
    // Display keeps the first-seen casing, not the lowercased key.
    expect(i.headline).toBe("Top contacts: Nick Hoxsie");
    expect(i.headline).not.toMatch(/nick hoxsie/);
  });
  test("ignores blank / non-string attendee entries defensively", () => {
    const events = [
      ev(-DAY / 60_000, 30, ["Nick Hoxsie", "", "  "]),
      // @ts-expect-error — emulate a malformed payload
      ev(-2 * DAY / 60_000, 30, ["Nick Hoxsie", null, undefined, 42 as any]),
    ];
    const i = recurringAttendeesInsight(events, NOW, 7);
    expect(i.metric).toBe(2);
    expect(i.headline).toBe("Top contacts: Nick Hoxsie");
  });
});

describe("computeInsights + sortBySeverity", () => {
  test("returns six insights in declared order", () => {
    const insights = computeInsights({
      events: [ev(-30, 30)],
      emails: [email()],
      tasks: [task()],
      nowMs: NOW,
    });
    expect(insights.map((i) => i.id)).toEqual([
      "meeting_load",
      "focus_time",
      "task_churn",
      "overdue_tasks",
      "followup_gap",
      "recurring_attendees",
    ]);
  });
  test("sortBySeverity puts risk/warn first", () => {
    const sorted = sortBySeverity([
      { id: "a", kind: "calendar", severity: "ok", headline: "", detail: "", metric: null },
      { id: "b", kind: "calendar", severity: "risk", headline: "", detail: "", metric: null },
      { id: "c", kind: "calendar", severity: "warn", headline: "", detail: "", metric: null },
      { id: "d", kind: "calendar", severity: "info", headline: "", detail: "", metric: null },
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["b", "c", "d", "a"]);
  });
});
