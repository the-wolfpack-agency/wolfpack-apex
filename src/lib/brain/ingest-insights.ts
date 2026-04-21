/**
 * Brain ingestion for MS 365 artifacts — prebriefs + insights snapshots.
 *
 * Every computed prebrief and every insights pass writes a compact
 * knowledge point into the Brain store so the assistant can later
 * answer "what was the prebrief for meeting X?" / "what insights did
 * we see last Monday?" from the same RAG layer that serves uploaded
 * docs and discussions.
 *
 * Fire-and-forget. Never throws. Never blocks the HTTP response.
 */

import { upsertKnowledgePoint } from "@/lib/qdrant";

interface PrebriefSummary {
  meetingId: string;
  subject: string;
  start: string;
  attendeeEmails: string[];
  threadSubjects: string[];
  openTaskTitles: string[];
  linkedGoalTitle: string | null;
}

export async function ingestPrebriefToBrain(
  userId: string,
  summary: PrebriefSummary,
): Promise<void> {
  try {
    const answer = [
      `Meeting: ${summary.subject}`,
      `Start: ${summary.start}`,
      summary.attendeeEmails.length
        ? `Attendees: ${summary.attendeeEmails.join(", ")}`
        : "Attendees: (none)",
      summary.threadSubjects.length
        ? `Recent threads: ${summary.threadSubjects.join(" | ")}`
        : "Recent threads: none",
      summary.openTaskTitles.length
        ? `Open tasks: ${summary.openTaskTitles.join(" | ")}`
        : "Open tasks: none",
      summary.linkedGoalTitle ? `Linked goal: ${summary.linkedGoalTitle}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await upsertKnowledgePoint(
      `ms-prebrief:${summary.meetingId}`,
      `Meeting pre-brief: ${summary.subject}`,
      answer,
      "ms365.prebrief",
      ["ms365", "meeting", "prebrief", userId],
    );
  } catch {
    /* fire-and-forget */
  }
}

interface InsightSnapshot {
  id: string;
  kind: string;
  severity: string;
  headline: string;
  detail: string;
  metric: number | null;
}

interface CalendarRangeSnapshot {
  view: "week" | "month" | "year";
  startMs: number;
  endMs: number;
  insights: {
    totalMeetingHours: number;
    meetingCount: number;
    averageDurationMinutes: number | null;
    backToBackPct: number;
    topAttendees: Array<{ display: string; count: number }>;
  };
  suggestions: Array<{ id: string; severity: string; headline: string; detail: string }>;
}

export async function ingestCalendarRangeToBrain(
  userId: string,
  userRole: string,
  snap: CalendarRangeSnapshot,
): Promise<void> {
  try {
    const startIso = new Date(snap.startMs).toISOString().split("T")[0];
    const endIso = new Date(snap.endMs).toISOString().split("T")[0];
    const top = snap.insights.topAttendees
      .map((a) => `${a.display} (${a.count})`)
      .join(", ");
    const suggestionText = snap.suggestions
      .map((s) => `[${s.severity.toUpperCase()}] ${s.id}: ${s.headline}`)
      .join("\n");
    const answer = [
      `View: ${snap.view} (${startIso} → ${endIso})`,
      `Meetings: ${snap.insights.meetingCount} · ${snap.insights.totalMeetingHours}h total`,
      snap.insights.averageDurationMinutes !== null
        ? `Avg duration: ${snap.insights.averageDurationMinutes} min`
        : "Avg duration: n/a",
      `Back-to-back: ${snap.insights.backToBackPct}%`,
      top ? `Top contacts: ${top}` : "Top contacts: n/a",
      suggestionText ? `Suggestions:\n${suggestionText}` : "Suggestions: none",
    ].join("\n");
    await upsertKnowledgePoint(
      `calendar-range:${userId}:${snap.view}:${startIso}`,
      `Calendar ${snap.view} — ${startIso}`,
      answer,
      "calendar.range",
      ["calendar", snap.view, userRole, startIso],
    );
  } catch {
    /* fire-and-forget */
  }
}

export async function ingestInsightsToBrain(
  userId: string,
  userRole: string,
  insights: InsightSnapshot[],
  nowMs: number,
): Promise<void> {
  try {
    const day = new Date(nowMs).toISOString().split("T")[0];
    const answer = insights
      .map(
        (i) =>
          `[${i.severity.toUpperCase()}] ${i.id} (${i.kind}): ${i.headline} — ${i.detail}` +
          (i.metric !== null ? ` (metric=${i.metric})` : ""),
      )
      .join("\n");

    await upsertKnowledgePoint(
      `ms-insights:${userId}:${day}`,
      `MS 365 insights snapshot — ${day}`,
      answer,
      "ms365.insights",
      ["ms365", "insights", userRole, day],
    );
  } catch {
    /* fire-and-forget */
  }
}
