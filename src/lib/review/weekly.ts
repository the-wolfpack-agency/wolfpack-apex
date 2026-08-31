/**
 * Weekly Review aggregator.
 *
 * Pulls a Mon→Sun retrospective together from the MS Graph calendar
 * feed, the local Outlook-emails pull, and the cached MS Tasks store:
 *
 *   - meetingsAttended   — calendar events whose end falls inside
 *                          [weekStart, weekEnd] (we treat the event list
 *                          as the attendance list; a future pass could
 *                          filter out declined responses).
 *   - tasksClosed        — cached tasks with completedAt inside the week.
 *   - tasksOpened        — cached tasks with createdAt inside the week.
 *   - unansweredFlagged  — recent emails that are high importance AND
 *                          unread AND arrived inside the week.
 *   - slips              — slipDetector output projected onto the UI
 *                          shape: { id, title, reason, dueAt }.
 *
 * Pure-ish: this module does Graph + DB reads via the two canonical
 * libs but performs no writes. `computeWeeklyReview` is safe to call
 * multiple times.
 */

import { fetchCalendarEvents, fetchRecentEmails } from "@/lib/microsoft-graph";
import { listCachedTasks, type MsTask } from "@/lib/integrations/microsoft-tasks";
import { detectSlips, type SlipReason } from "@/lib/review/slip-detector";

export interface WeeklyReviewSlip {
  id: string;
  title: string;
  reason: SlipReason;
  dueAt: string | null;
}

export interface WeeklyReview {
  weekStart: string; // ISO UTC
  weekEnd: string;   // ISO UTC — exclusive upper bound (Mon next week)
  meetingsAttended: number;
  tasksClosed: number;
  tasksOpened: number;
  unansweredFlagged: number;
  slips: WeeklyReviewSlip[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Return the UTC Monday-00:00 of the week containing `d`. Mon=1…Sun=7
 * under ISO; JS getUTCDay returns Sun=0…Sat=6, so we normalize to an
 * offset where Monday = 0.
 */
export function mondayOf(d: Date): Date {
  const dow = d.getUTCDay(); // 0..6, Sun=0
  const offsetToMonday = (dow + 6) % 7; // Mon→0, Sun→6
  const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    - offsetToMonday * DAY_MS;
  return new Date(ms);
}

function inWindow(iso: string | null, startMs: number, endMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t >= startMs && t < endMs;
}

export async function computeWeeklyReview(
  userId: string,
  weekStart: Date,
): Promise<WeeklyReview> {
  const start = mondayOf(weekStart);
  const end = new Date(start.getTime() + 7 * DAY_MS);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [events, emails, tasksPage] = await Promise.all([
    fetchCalendarEvents(userId, startIso, endIso).catch(() => []),
    fetchRecentEmails(userId, 50).catch(() => []),
    listCachedTasks(userId, { limit: 200 }).catch(() => ({ tasks: [] as MsTask[], nextCursor: null })),
  ]);

  const meetingsAttended = events.filter((ev) => inWindow(ev.end, startMs, endMs)).length;

  const tasks = tasksPage.tasks ?? [];
  const tasksClosed = tasks.filter((t) => inWindow(t.completedAt, startMs, endMs)).length;
  const tasksOpened = tasks.filter((t) => inWindow(t.createdAt, startMs, endMs)).length;

  const unansweredFlagged = emails.filter(
    (e) =>
      e.importance === "high" &&
      !e.isRead &&
      inWindow(e.receivedDateTime, startMs, endMs),
  ).length;

  const { slipped, reasons } = detectSlips(tasks);
  const slips: WeeklyReviewSlip[] = slipped.map((t) => ({
    id: t.id,
    title: t.title,
    reason: reasons[t.id],
    dueAt: t.dueAt,
  }));

  return {
    weekStart: startIso,
    weekEnd: endIso,
    meetingsAttended,
    tasksClosed,
    tasksOpened,
    unansweredFlagged,
    slips,
  };
}
