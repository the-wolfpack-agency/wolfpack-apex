/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * listUpcomingMeetings + pickDefaultMeeting
 *
 * Coverage:
 *   - sorts soonest-first and truncates to limit
 *   - filters out meetings that ended before the lookback window
 *   - flags in-progress meetings + computes minutesUntil correctly
 *   - returns [] when fetchCalendarEvents throws (dashboard prefers empty
 *     over broken)
 *   - pickDefaultMeeting prefers in-progress > upcoming > most-recent-ended
 */

const mockFetchCalendarEvents = jest.fn();

jest.mock("@/lib/microsoft-graph", () => ({
  fetchCalendarEvents: (...a: any[]) => mockFetchCalendarEvents(...a),
}));

import { listUpcomingMeetings, pickDefaultMeeting } from "@/lib/meetings/upcoming";

const NOW = Date.parse("2026-04-21T10:00:00Z");

function ev(
  id: string,
  offsetMinutes: number,
  durationMinutes = 30,
  overrides: Partial<{ subject: string; location: string; attendees: string[] }> = {},
) {
  const start = new Date(NOW + offsetMinutes * 60_000).toISOString();
  const end = new Date(NOW + (offsetMinutes + durationMinutes) * 60_000).toISOString();
  return {
    id,
    subject: overrides.subject ?? `Event ${id}`,
    start,
    end,
    location: overrides.location ?? "Teams",
    attendees: overrides.attendees ?? [],
    isOnlineMeeting: true,
  };
}

beforeEach(() => {
  mockFetchCalendarEvents.mockReset();
});

describe("listUpcomingMeetings", () => {
  test("returns meetings inside the window sorted soonest-first", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      ev("c", 300), // 5h out
      ev("a", 30),  // 30m out
      ev("b", 120), // 2h out
    ]);
    const out = await listUpcomingMeetings("u1", { nowMs: NOW });
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(out[0].minutesUntil).toBe(30);
    expect(out[1].minutesUntil).toBe(120);
    expect(out[2].minutesUntil).toBe(300);
  });

  test("drops meetings that ended before the lookback window", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      // Ended 2 hours ago - outside default 30m lookback
      ev("old", -180, 60),
      // Ended 10 minutes ago - inside 30m lookback
      ev("recent", -40, 30),
      // Upcoming
      ev("next", 45, 30),
    ]);
    const out = await listUpcomingMeetings("u1", { nowMs: NOW });
    expect(out.map((m) => m.id)).toEqual(["recent", "next"]);
  });

  test("flags in-progress meetings and reports minutesUntil <= 0", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      // started 10m ago, ends 20m from now
      ev("live", -10, 30),
      ev("later", 120, 30),
    ]);
    const out = await listUpcomingMeetings("u1", { nowMs: NOW });
    const live = out.find((m) => m.id === "live")!;
    expect(live.inProgress).toBe(true);
    expect(live.minutesUntil).toBe(-10);
    const later = out.find((m) => m.id === "later")!;
    expect(later.inProgress).toBe(false);
  });

  test("honors lookaheadHours override (default 48h → narrower 4h drops far-out events)", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      ev("soon", 60),
      ev("tomorrow", 26 * 60),
    ]);
    mockFetchCalendarEvents.mockImplementationOnce(async (_uid: string, _s: string, e: string) => {
      // Emulate provider pre-filtering on its side too: it would never
      // return tomorrow's event if asked for a 4h window. But the lib
      // is defensive — it filters client-side as well. We return both
      // so we can verify the lib's own guard: lookaheadHours is passed
      // into fetchCalendarEvents via the ISO window only, so we just
      // assert the call signature.
      const endT = Date.parse(e);
      expect(endT - NOW).toBeLessThanOrEqual(4 * 60 * 60_000 + 1000);
      return [ev("soon", 60)];
    });
    const out = await listUpcomingMeetings("u1", { nowMs: NOW, lookaheadHours: 4 });
    expect(out.map((m) => m.id)).toEqual(["soon"]);
  });

  test("truncates to limit after sorting", async () => {
    mockFetchCalendarEvents.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ev(`e${i}`, 60 + i * 30)),
    );
    const out = await listUpcomingMeetings("u1", { nowMs: NOW, limit: 3 });
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.id)).toEqual(["e0", "e1", "e2"]);
  });

  test("returns [] when fetchCalendarEvents rejects", async () => {
    mockFetchCalendarEvents.mockRejectedValue(new Error("graph down"));
    const out = await listUpcomingMeetings("u1", { nowMs: NOW });
    expect(out).toEqual([]);
  });

  test("skips events with unparseable start time", async () => {
    mockFetchCalendarEvents.mockResolvedValue([
      { ...ev("bad", 30), start: "not-a-date" },
      ev("good", 60),
    ]);
    const out = await listUpcomingMeetings("u1", { nowMs: NOW });
    expect(out.map((m) => m.id)).toEqual(["good"]);
  });
});

describe("pickDefaultMeeting", () => {
  test("returns null for empty list", () => {
    expect(pickDefaultMeeting([])).toBeNull();
  });

  test("prefers in-progress over upcoming", () => {
    const meetings = [
      { ...ev("upcoming", 60), minutesUntil: 60, inProgress: false },
      { ...ev("live", -5, 30), minutesUntil: -5, inProgress: true },
    ];
    const picked = pickDefaultMeeting(meetings as any);
    expect(picked?.id).toBe("live");
  });

  test("returns soonest upcoming when nothing is in progress", () => {
    const meetings = [
      { ...ev("later", 120), minutesUntil: 120, inProgress: false },
      { ...ev("soonest", 30), minutesUntil: 30, inProgress: false },
    ];
    const picked = pickDefaultMeeting(meetings as any);
    expect(picked?.id).toBe("soonest");
  });

  test("falls back to most-recent-ended when list is all past", () => {
    const meetings = [
      { ...ev("old", -120, 30), minutesUntil: -120, inProgress: false },
      { ...ev("recent", -15, 30), minutesUntil: -15, inProgress: false },
    ];
    const picked = pickDefaultMeeting(meetings as any);
    expect(picked?.id).toBe("recent");
  });
});
