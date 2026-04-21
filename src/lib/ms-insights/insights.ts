/**
 * MS 365 Insights — pure pattern functions over calendar + tasks + email.
 *
 * Nothing in this module calls out to Graph. Callers fetch the raw data
 * (already cached + rate-limited inside microsoft-graph.ts /
 * microsoft-tasks.ts) and pass it in. Keeping the patterns
 * side-effect-free means:
 *   1. the unit tests never need network mocks
 *   2. the same patterns can run offline over cached data
 *   3. adding a new insight never risks introducing a new Graph call
 *
 * Every insight carries: id, kind, severity, headline, detail, metric,
 * and (optional) cta. The UI renders them uniformly; the learning loop
 * can group by `id` and grade which insights the user actually clicks.
 */

import type { CalendarEvent, Email } from "@/lib/microsoft-graph";
import type { MsTask } from "@/lib/integrations/microsoft-tasks";

export type InsightSeverity = "ok" | "info" | "warn" | "risk";

export interface Insight {
  /** Stable id (`meeting_load`, `focus_time`, `task_churn`, `followup_gap`,
   *  `recurring_attendees`, `overdue_tasks`). */
  id: string;
  /** Grouping: what data fed this insight. */
  kind: "calendar" | "tasks" | "email" | "mixed";
  severity: InsightSeverity;
  headline: string;
  detail: string;
  /** Optional numeric metric for charts / learning-loop comparisons. */
  metric: number | null;
  /** Optional CTA the UI can render as a button. */
  cta?: { label: string; href: string };
}

export interface ComputeInsightsInput {
  events: CalendarEvent[];
  emails: Email[];
  tasks: MsTask[];
  /** Current time in ms since epoch. Tests override. */
  nowMs?: number;
  /** How many days back to consider for trend insights. Default 7. */
  lookbackDays?: number;
}

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function sameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// ---------------------------------------------------------------------------
// Individual insight computers
// ---------------------------------------------------------------------------

/**
 * Meeting load: total meeting hours scheduled today. Flags days where
 * meetings exceed 6 hours (half the workday) as a focus risk.
 */
export function meetingLoadInsight(
  events: CalendarEvent[],
  nowMs: number,
): Insight {
  let totalMins = 0;
  let count = 0;
  for (const e of events) {
    const startMs = parseMs(e.start);
    const endMs = parseMs(e.end);
    if (startMs === null || endMs === null) continue;
    if (!sameLocalDay(startMs, nowMs)) continue;
    totalMins += Math.max(0, (endMs - startMs) / MS_PER_MIN);
    count += 1;
  }
  const hours = +(totalMins / 60).toFixed(1);
  let severity: InsightSeverity = "ok";
  let headline = `${count} meeting${count === 1 ? "" : "s"} today (${hours}h total)`;
  let detail = "Calendar load is sustainable.";
  if (hours >= 6) {
    severity = "risk";
    detail = "Over half your day is in meetings — consider declining one or batching.";
  } else if (hours >= 4) {
    severity = "warn";
    detail = "Heavy meeting day. Block time for deep work if you can.";
  } else if (count === 0) {
    severity = "ok";
    headline = "No meetings today";
    detail = "Open calendar — good day for focused work.";
  }
  return {
    id: "meeting_load",
    kind: "calendar",
    severity,
    headline,
    detail,
    metric: hours,
  };
}

/**
 * Longest uninterrupted "free" block in today's calendar between 9am and
 * 6pm local time. Flags days with < 60 minutes as a focus risk.
 */
export function focusTimeInsight(
  events: CalendarEvent[],
  nowMs: number,
): Insight {
  const day = new Date(nowMs);
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0).getTime();
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 18, 0, 0).getTime();
  const blocks: Array<{ start: number; end: number }> = [];
  for (const e of events) {
    const s = parseMs(e.start);
    const en = parseMs(e.end);
    if (s === null || en === null) continue;
    if (en <= dayStart || s >= dayEnd) continue;
    blocks.push({ start: Math.max(s, dayStart), end: Math.min(en, dayEnd) });
  }
  blocks.sort((a, b) => a.start - b.start);
  // Merge overlaps so we measure true free time.
  const merged: Array<{ start: number; end: number }> = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
    } else {
      merged.push({ ...b });
    }
  }
  let cursor = dayStart;
  let longestGapMs = 0;
  for (const b of merged) {
    longestGapMs = Math.max(longestGapMs, b.start - cursor);
    cursor = Math.max(cursor, b.end);
  }
  longestGapMs = Math.max(longestGapMs, dayEnd - cursor);

  const mins = Math.max(0, Math.round(longestGapMs / MS_PER_MIN));
  let severity: InsightSeverity = "ok";
  let detail = "Longest free block today is enough for meaningful deep work.";
  if (mins < 30) {
    severity = "risk";
    detail = "Calendar is fully fragmented — almost no room for focused work.";
  } else if (mins < 60) {
    severity = "warn";
    detail = "Longest free block is under an hour. Consider consolidating meetings.";
  }
  return {
    id: "focus_time",
    kind: "calendar",
    severity,
    headline: `${mins} min of focus time available`,
    detail,
    metric: mins,
  };
}

/**
 * Task churn: tasks opened vs completed inside the lookback window.
 * Flags when the user is closing <50% of what they open (growing backlog).
 */
export function taskChurnInsight(
  tasks: MsTask[],
  nowMs: number,
  lookbackDays: number,
): Insight {
  const cutoff = nowMs - lookbackDays * MS_PER_DAY;
  let opened = 0;
  let closed = 0;
  for (const t of tasks) {
    const created = parseMs(t.createdAt);
    const completed = parseMs(t.completedAt);
    if (created !== null && created >= cutoff) opened += 1;
    if (completed !== null && completed >= cutoff) closed += 1;
  }
  const ratio = opened === 0 ? null : +(closed / opened).toFixed(2);
  let severity: InsightSeverity = "info";
  let detail = `Last ${lookbackDays} days: ${opened} opened, ${closed} closed.`;
  if (opened === 0 && closed === 0) {
    severity = "info";
    detail = `No task activity in the last ${lookbackDays} days.`;
  } else if (ratio !== null && ratio < 0.5 && opened >= 3) {
    severity = "warn";
    detail += " Backlog is growing — you're closing less than half of what you open.";
  } else if (ratio !== null && ratio >= 1) {
    severity = "ok";
    detail += " You closed at least as many as you opened.";
  }
  return {
    id: "task_churn",
    kind: "tasks",
    severity,
    headline: `Task churn: ${opened} in / ${closed} done`,
    detail,
    metric: ratio,
  };
}

/**
 * Overdue tasks: count + oldest age in days.
 */
export function overdueTasksInsight(tasks: MsTask[], nowMs: number): Insight {
  let count = 0;
  let oldestDueMs: number | null = null;
  for (const t of tasks) {
    if (t.status === "completed") continue;
    const dueMs = parseMs(t.dueAt);
    if (dueMs === null || dueMs >= nowMs) continue;
    count += 1;
    if (oldestDueMs === null || dueMs < oldestDueMs) oldestDueMs = dueMs;
  }
  const oldestDays =
    oldestDueMs === null ? 0 : Math.max(0, Math.floor((nowMs - oldestDueMs) / MS_PER_DAY));
  let severity: InsightSeverity = "ok";
  let headline = "No overdue tasks";
  let detail = "You're on top of due dates.";
  if (count > 0) {
    severity = oldestDays >= 7 ? "risk" : oldestDays >= 3 ? "warn" : "info";
    headline = `${count} overdue task${count === 1 ? "" : "s"}`;
    detail = `Oldest is ${oldestDays} day${oldestDays === 1 ? "" : "s"} past due.`;
  }
  return {
    id: "overdue_tasks",
    kind: "tasks",
    severity,
    headline,
    detail,
    metric: count,
    cta: count > 0 ? { label: "Open tasks", href: "/tasks" } : undefined,
  };
}

/**
 * Follow-up gap: counts unique "from" addresses on unread / recent emails
 * that look like they're waiting on a reply (importance high or received
 * in the last 48h with subject starting "Re:" absent — i.e., they opened
 * the thread). This is a coarse heuristic meant to prompt the user to
 * triage, not a precise SLA tracker.
 */
export function followUpGapInsight(emails: Email[], nowMs: number): Insight {
  const twoDaysAgo = nowMs - 2 * MS_PER_DAY;
  const pending = new Set<string>();
  for (const e of emails) {
    const received = parseMs(e.receivedDateTime);
    if (received === null) continue;
    if (received < twoDaysAgo) continue;
    if (e.isRead && e.importance !== "high") continue;
    if (!e.fromEmail) continue;
    pending.add(e.fromEmail.toLowerCase());
  }
  const count = pending.size;
  let severity: InsightSeverity = "ok";
  let headline = "Inbox is under control";
  let detail = "No recent unread-or-important senders waiting.";
  if (count > 0) {
    severity = count >= 5 ? "warn" : "info";
    headline = `${count} sender${count === 1 ? "" : "s"} likely waiting on you`;
    detail = `Unread or high-importance mail from ${count} contact${count === 1 ? "" : "s"} in the last 48 h.`;
  }
  return {
    id: "followup_gap",
    kind: "email",
    severity,
    headline,
    detail,
    metric: count,
    cta: count > 0 ? { label: "Open Inbox", href: "/emails" } : undefined,
  };
}

/**
 * Recurring attendees: who you're meeting with the most this week.
 * Returns the top 3 contacts and their meeting count. Purely
 * informational but feeds the relationship-graph ontology.
 */
export function recurringAttendeesInsight(
  events: CalendarEvent[],
  nowMs: number,
  lookbackDays: number,
): Insight {
  const cutoff = nowMs - lookbackDays * MS_PER_DAY;
  const counts = new Map<string, { display: string; count: number }>();
  for (const e of events) {
    const s = parseMs(e.start);
    if (s === null || s < cutoff || s > nowMs + 7 * MS_PER_DAY) continue;
    for (const a of e.attendees) {
      if (!a || typeof a !== "string") continue;
      const trimmed = a.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { display: trimmed, count: 1 });
    }
  }
  const top = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  if (top.length === 0) {
    return {
      id: "recurring_attendees",
      kind: "calendar",
      severity: "info",
      headline: "No recurring meeting contacts",
      detail: `Nobody appears in more than one meeting in the last ${lookbackDays} days.`,
      metric: 0,
    };
  }
  const list = top.map((t) => `${t.display} (${t.count})`).join(", ");
  return {
    id: "recurring_attendees",
    kind: "calendar",
    severity: "info",
    headline: `Top contacts: ${top[0].display}`,
    detail: `Most-seen this ${lookbackDays === 7 ? "week" : `${lookbackDays}d`}: ${list}.`,
    metric: top[0].count,
  };
}

// ---------------------------------------------------------------------------
// Top-level composer
// ---------------------------------------------------------------------------

/**
 * Compute the full set of insights from raw MS data. Order is the
 * default dashboard display order; the caller can re-sort by severity
 * without losing insight stability.
 */
export function computeInsights(input: ComputeInsightsInput): Insight[] {
  const nowMs = input.nowMs ?? Date.now();
  const lookbackDays = input.lookbackDays ?? 7;
  return [
    meetingLoadInsight(input.events, nowMs),
    focusTimeInsight(input.events, nowMs),
    taskChurnInsight(input.tasks, nowMs, lookbackDays),
    overdueTasksInsight(input.tasks, nowMs),
    followUpGapInsight(input.emails, nowMs),
    recurringAttendeesInsight(input.events, nowMs, lookbackDays),
  ];
}

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  risk: 0,
  warn: 1,
  info: 2,
  ok: 3,
};

/** Helper for the UI: sort risk/warn first, keeping stable within bucket. */
export function sortBySeverity(insights: Insight[]): Insight[] {
  return [...insights].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}
