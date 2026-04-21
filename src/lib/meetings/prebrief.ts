/**
 * Meeting Pre-Brief — pure composition layer.
 *
 * Given a userId + meetingId, pull everything the CEO wants to see
 * 15 minutes before a meeting starts:
 *   - the meeting itself (from Microsoft Graph calendar)
 *   - attendee emails (resolved from the meeting's attendee list)
 *   - last 3 email threads with those attendees
 *   - that user's open (non-completed) tasks
 *   - the linked company goal, if an instinct_entity_links row exists
 *   - the most recent decision captured (currently always null — no
 *     instinct_meeting_decisions table yet)
 *
 * Kept intentionally side-effect-free (no analytics here) so the route
 * handler owns the trackEvent call and the shape can be reused by
 * future server-rendered surfaces.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  fetchCalendarEvents,
  fetchEmailsFromContact,
  type CalendarEvent,
  type Email,
} from "@/lib/microsoft-graph";
import {
  listCachedTasks,
  type MsTask,
} from "@/lib/integrations/microsoft-tasks";
import { safeQuery } from "@/lib/db";

export interface PrebriefLinkedGoal {
  id: string;
  title: string;
}

export interface PrebriefResult {
  meeting: CalendarEvent;
  attendeeEmails: string[];
  recentThreads: Email[];
  openTasks: MsTask[];
  linkedGoal: PrebriefLinkedGoal | null;
  decisionSnippet: string | null;
}

/**
 * Heuristic: pull a 30-day window around today so we capture today's
 * meeting regardless of exact server-vs-user TZ drift. The calendar
 * helper dedupes via its own cache, so the wider window is cheap.
 */
function calendarWindow(): { start: string; end: string } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  return {
    start: new Date(now - 7 * day).toISOString(),
    end: new Date(now + 30 * day).toISOString(),
  };
}

/**
 * Extract email-looking tokens from the CalendarEvent.attendees list.
 * Graph hands us either display names or raw addresses depending on
 * which mailbox the invitee is on — the shape is "one-or-the-other
 * per entry." We keep anything containing an "@".
 */
function extractEmails(attendees: string[]): string[] {
  const out: string[] = [];
  for (const a of attendees) {
    if (typeof a === "string" && a.includes("@")) {
      const trimmed = a.trim().toLowerCase();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

async function fetchLinkedGoal(
  meetingId: string,
): Promise<PrebriefLinkedGoal | null> {
  try {
    const { rows } = await safeQuery<{ to_entity_id: string; title: string | null }>(
      `SELECT l.to_entity_id,
              g.title AS title
       FROM instinct_entity_links l
       LEFT JOIN instinct_company_goals g ON g.id = l.to_entity_id
       WHERE l.from_entity_type = 'meeting'
         AND l.from_entity_id = $1
         AND l.to_entity_type = 'company_goal'
       ORDER BY l.created_at DESC
       LIMIT 1`,
      [meetingId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.to_entity_id, title: r.title || "Linked goal" };
  } catch {
    return null;
  }
}

/**
 * Pull open (non-completed) tasks for the user, capped so the API
 * response stays small. Surfaces waitingOnOthers + inProgress + notStarted
 * — anything the user still owns.
 */
async function fetchOpenTasks(userId: string): Promise<MsTask[]> {
  const statuses: MsTask["status"][] = ["notStarted", "inProgress", "waitingOnOthers"];
  const collected: MsTask[] = [];
  for (const status of statuses) {
    try {
      const page = await listCachedTasks(userId, { status, limit: 25 });
      for (const t of page.tasks) {
        if (!collected.find((c) => c.id === t.id)) collected.push(t);
      }
    } catch {
      /* skip — cache read shouldn't block the brief */
    }
  }
  return collected.slice(0, 10);
}

export async function computePrebrief(
  userId: string,
  meetingId: string,
): Promise<PrebriefResult | null> {
  const { start, end } = calendarWindow();
  const events = await fetchCalendarEvents(userId, start, end);
  const meeting = events.find((e) => e.id === meetingId) || null;
  if (!meeting) return null;

  const attendeeEmails = extractEmails(meeting.attendees);

  const threadPromises = attendeeEmails.slice(0, 5).map((email) =>
    fetchEmailsFromContact(userId, email, 3).catch(() => [] as Email[]),
  );
  const threadLists = await Promise.all(threadPromises);
  const allThreads = threadLists.flat();
  // Sort newest-first, keep top 3.
  allThreads.sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : -1));
  const recentThreads = allThreads.slice(0, 3);

  const [openTasks, linkedGoal] = await Promise.all([
    fetchOpenTasks(userId),
    fetchLinkedGoal(meetingId),
  ]);

  return {
    meeting,
    attendeeEmails,
    recentThreads,
    openTasks,
    linkedGoal,
    decisionSnippet: null,
  };
}
