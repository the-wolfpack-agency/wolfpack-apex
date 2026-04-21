/**
 * Calendar suggestions — deterministic, rule-based advice derived from
 * HistoricalInsights. Zero AI tokens; every rule runs at scale.
 *
 * Output is a stable array of suggestions with ids so the learning
 * loop can track which ones the user engages with.
 */

import type { HistoricalInsights } from "./historical-insights";

export type SuggestionSeverity = "info" | "watch" | "act";

export interface Suggestion {
  id: string;
  severity: SuggestionSeverity;
  headline: string;
  detail: string;
  /** Optional CTA for the UI. */
  cta?: { label: string; href: string };
}

interface GenerateInput {
  insights: HistoricalInsights;
  view: "week" | "month" | "year";
}

export function generateCalendarSuggestions(input: GenerateInput): Suggestion[] {
  const out: Suggestion[] = [];
  const { insights, view } = input;

  // 1. Meeting overload — more than 20h/week average.
  if (insights.weeklySeries.length > 0) {
    const avgHours =
      insights.weeklySeries.reduce((acc, w) => acc + w.hours, 0) /
      insights.weeklySeries.length;
    if (avgHours >= 20) {
      out.push({
        id: "overload_weekly_hours",
        severity: "act",
        headline: `Meeting load averages ${avgHours.toFixed(1)}h/week`,
        detail:
          "You're spending more than half a workweek in meetings. Consider declining recurring standing meetings you don't drive, or batching 1:1s into a single block.",
      });
    } else if (avgHours >= 12) {
      out.push({
        id: "watch_weekly_hours",
        severity: "watch",
        headline: `Weekly meeting load trending heavy (${avgHours.toFixed(1)}h avg)`,
        detail: "Not critical yet, but worth auditing recurring invites.",
      });
    } else {
      out.push({
        id: "ok_weekly_hours",
        severity: "info",
        headline: `Weekly meeting load is sustainable (${avgHours.toFixed(1)}h avg)`,
        detail: "You have room for deep-work blocks.",
      });
    }
  }

  // 2. Back-to-back density — 40%+ is fatiguing.
  if (insights.backToBackPct >= 40 && insights.meetingCount >= 3) {
    out.push({
      id: "back_to_back_density",
      severity: "act",
      headline: `${insights.backToBackPct}% of meetings are back-to-back`,
      detail:
        "Insert 5-10 minute buffers between meetings so you can capture notes and prep for the next conversation.",
    });
  }

  // 3. Average duration — sub-30-min average suggests good hygiene;
  //    > 50 min average suggests default-to-hour-long inertia.
  if (insights.averageDurationMinutes !== null && insights.meetingCount >= 3) {
    if (insights.averageDurationMinutes >= 50) {
      out.push({
        id: "long_default_duration",
        severity: "watch",
        headline: `Average meeting is ${insights.averageDurationMinutes} min`,
        detail:
          "Default to 25/50-minute meetings instead of 30/60 to claw back 2-3 hours a week.",
      });
    }
  }

  // 4. Top-contact concentration — if one person is in >60% of
  //    meetings across the window, flag the 1:1 density.
  if (insights.meetingCount >= 5 && insights.topAttendees.length > 0) {
    const top = insights.topAttendees[0];
    const share = top.count / insights.meetingCount;
    if (share >= 0.6) {
      out.push({
        id: "single_contact_concentration",
        severity: "watch",
        headline: `${Math.round(share * 100)}% of meetings are with ${top.display}`,
        detail:
          "Heavy 1:1 concentration — consider batching updates into a weekly 30-min instead of daily drop-ins.",
      });
    }
  }

  // 5. Day-of-week skew — if one weekday carries 50%+ of the load,
  //    surface it for trend awareness.
  if (insights.meetingCount >= 5) {
    const total = insights.dayOfWeekDistribution.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const maxIdx = insights.dayOfWeekDistribution.reduce(
        (best, v, i, arr) => (v > arr[best] ? i : best),
        0,
      );
      const maxShare = insights.dayOfWeekDistribution[maxIdx] / total;
      if (maxShare >= 0.5) {
        const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        out.push({
          id: "day_of_week_skew",
          severity: "info",
          headline: `${Math.round(maxShare * 100)}% of meetings land on ${labels[maxIdx]}`,
          detail: `Consider spreading load across the ${view === "week" ? "week" : "calendar"} for more consistent focus time.`,
        });
      }
    }
  }

  // 6. Zero-meeting range — celebrate / warn depending on length.
  if (insights.meetingCount === 0) {
    out.push({
      id: "no_meetings_in_range",
      severity: "info",
      headline: "No meetings in the selected range",
      detail:
        view === "year"
          ? "The year has no scheduled meetings yet — early planning stage."
          : "Clear calendar — good window for deep work or proactive outreach.",
    });
  }

  return out;
}
