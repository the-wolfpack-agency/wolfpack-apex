/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateCalendarSuggestions } from "@/lib/calendar/suggestions";
import type { HistoricalInsights } from "@/lib/calendar/historical-insights";

function insights(over: Partial<HistoricalInsights> = {}): HistoricalInsights {
  return {
    totalMeetingHours: 0,
    meetingCount: 0,
    soloBlockCount: 0,
    averageDurationMinutes: null,
    backToBackPct: 0,
    topAttendees: [],
    weeklySeries: [],
    dayOfWeekDistribution: [0, 0, 0, 0, 0, 0, 0],
    ...over,
  };
}

describe("generateCalendarSuggestions", () => {
  test("flags 20h+ weekly average as 'act'", () => {
    const out = generateCalendarSuggestions({
      view: "month",
      insights: insights({
        meetingCount: 10,
        weeklySeries: [
          { weekStartIso: "2026-04-05T00:00:00Z", hours: 22, count: 10 },
          { weekStartIso: "2026-04-12T00:00:00Z", hours: 22, count: 10 },
        ],
      }),
    });
    const overload = out.find((s) => s.id === "overload_weekly_hours");
    expect(overload?.severity).toBe("act");
  });

  test("reports 'ok' when weekly hours are low", () => {
    const out = generateCalendarSuggestions({
      view: "week",
      insights: insights({
        meetingCount: 3,
        weeklySeries: [{ weekStartIso: "2026-04-19T00:00:00Z", hours: 4, count: 3 }],
      }),
    });
    expect(out.find((s) => s.id === "ok_weekly_hours")).toBeTruthy();
  });

  test("flags back-to-back density >= 40%", () => {
    const out = generateCalendarSuggestions({
      view: "week",
      insights: insights({
        meetingCount: 10,
        backToBackPct: 50,
        weeklySeries: [{ weekStartIso: "2026-04-19T00:00:00Z", hours: 10, count: 10 }],
      }),
    });
    expect(out.find((s) => s.id === "back_to_back_density")).toBeTruthy();
  });

  test("flags 50+ min average duration", () => {
    const out = generateCalendarSuggestions({
      view: "week",
      insights: insights({
        meetingCount: 5,
        averageDurationMinutes: 55,
        weeklySeries: [{ weekStartIso: "2026-04-19T00:00:00Z", hours: 5, count: 5 }],
      }),
    });
    expect(out.find((s) => s.id === "long_default_duration")).toBeTruthy();
  });

  test("flags concentration when one contact is in 60%+ of meetings", () => {
    const out = generateCalendarSuggestions({
      view: "month",
      insights: insights({
        meetingCount: 10,
        topAttendees: [
          { display: "Sarah Chen", count: 7 },
          { display: "Alex Park", count: 2 },
        ],
        weeklySeries: [{ weekStartIso: "2026-04-05T00:00:00Z", hours: 10, count: 10 }],
      }),
    });
    expect(out.find((s) => s.id === "single_contact_concentration")).toBeTruthy();
  });

  test("surfaces day-of-week skew (one day >= 50% of meetings)", () => {
    const out = generateCalendarSuggestions({
      view: "week",
      insights: insights({
        meetingCount: 10,
        // 6 on Tuesday, 4 spread elsewhere
        dayOfWeekDistribution: [0, 0, 6, 1, 1, 1, 1],
        weeklySeries: [{ weekStartIso: "2026-04-19T00:00:00Z", hours: 10, count: 10 }],
      }),
    });
    expect(out.find((s) => s.id === "day_of_week_skew")?.headline).toContain("Tue");
  });

  test("empty-range suggestion fires when there are no meetings", () => {
    const out = generateCalendarSuggestions({
      view: "year",
      insights: insights(),
    });
    expect(out.find((s) => s.id === "no_meetings_in_range")).toBeTruthy();
  });

  test("returns stable ids (learning loop can dedupe views/clicks)", () => {
    const out = generateCalendarSuggestions({
      view: "month",
      insights: insights({
        meetingCount: 10,
        averageDurationMinutes: 55,
        backToBackPct: 60,
        weeklySeries: [{ weekStartIso: "2026-04-05T00:00:00Z", hours: 22, count: 10 }],
      }),
    });
    const ids = out.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
