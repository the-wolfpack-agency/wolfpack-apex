/**
 * Read the three systems a pilot actually lives in, and join them.
 *
 * Calendar (are we still meeting), the Brain (is material still landing) and
 * tasks (is the work closing). No one of those answers "how is the pilot
 * going". Together they do, and joining them is the thing a single connected
 * tool cannot do for itself.
 *
 * IMPORTS pg TRANSITIVELY. The shapes and all the arithmetic live in
 * status-shape.ts so a client component can render a reading without pulling
 * the database driver into the browser bundle.
 *
 * EVERY READ IS INDEPENDENT AND EVERY FAILURE IS NAMED. One source falling
 * over degrades the answer to a partial view; it never takes the answer down,
 * and it never silently becomes a zero. `listUpcomingMeetings` returns `[]` on
 * a Graph failure, which is indistinguishable from a clear diary, so this
 * module checks the connection separately rather than trusting the empty list.
 */

import { listUpcomingMeetings } from "@/lib/meetings/upcoming";
import { getConnectionStatus } from "@/lib/microsoft-graph";
import { listDocuments } from "@/lib/brain/repo";
import { listCachedTasks } from "@/lib/integrations/microsoft-tasks";
import type {
  PilotStatusReading,
  SourceReading,
  StatusDocument,
  StatusMeeting,
  StatusTask,
} from "./status-shape";

/** How far back "recently" reaches. Long enough for a fortnightly cadence. */
export const DEFAULT_WINDOW_DAYS = 14;

/** How far forward to look for the next checkpoint. */
const LOOKAHEAD_HOURS = 14 * 24;

export interface ReadPilotStatusOpts {
  userId: string;
  userRole: string;
  windowDays?: number;
  /** Injectable clock so the tests are not a function of the wall clock. */
  nowMs?: number;
}

/**
 * Calendar leg.
 *
 * The connection is checked FIRST and separately. `listUpcomingMeetings`
 * swallows a Graph failure into an empty array, so believing its emptiness
 * would report "no meetings booked" to somebody whose token had expired. That
 * exact shape (a cached failure read back as a fact about the user) is what
 * turned 354 failed Graph calls into "you have never emailed this person".
 */
async function readCalendar(
  userId: string,
  nowMs: number,
): Promise<SourceReading<StatusMeeting>> {
  let connected = false;
  try {
    const status = await getConnectionStatus(userId);
    connected = status.connected;
  } catch (err) {
    return {
      state: "unavailable",
      detail: `Could not check the Microsoft connection: ${(err as Error).message}`,
      items: [],
    };
  }
  if (!connected) {
    return {
      state: "not_connected",
      detail: "Microsoft 365 is not connected, so there is no calendar to read.",
      items: [],
    };
  }

  try {
    const meetings = await listUpcomingMeetings(userId, {
      lookaheadHours: LOOKAHEAD_HOURS,
      lookbackMinutes: 0,
      limit: 25,
      nowMs,
    });
    return {
      state: "ok",
      detail: null,
      items: meetings
        .filter((m) => !m.isOutOfOffice)
        .map((m) => ({
          id: m.id,
          subject: m.subject,
          start: m.start,
          attendees: m.attendees,
          minutesUntil: m.minutesUntil,
        })),
    };
  } catch (err) {
    return {
      state: "unavailable",
      detail: `The calendar read failed: ${(err as Error).message}`,
      items: [],
    };
  }
}

/** Brain leg: what material has landed, and is it answerable yet. */
async function readDocuments(
  windowStartMs: number,
): Promise<SourceReading<StatusDocument>> {
  try {
    const docs = await listDocuments({ limit: 200 });
    const recent = docs.filter((d) => {
      const t = Date.parse(d.created_at);
      return !Number.isNaN(t) && t >= windowStartMs;
    });
    return {
      state: "ok",
      detail: null,
      items: recent.map((d) => ({
        id: d.id,
        filename: d.filename,
        createdAt: d.created_at,
        /* "indexed" is the terminal success state in BrainStatus and the only
           one that can be quoted from; queued/extracting/chunking/embedding
           are uploaded but not answerable yet, which is a different thing to
           tell a client. Chunk count guards the case where the status says
           indexed and nothing was actually stored. */
        indexed: d.status === "indexed" && d.chunk_count > 0,
      })),
    };
  } catch (err) {
    return {
      state: "unavailable",
      detail: `The Brain read failed: ${(err as Error).message}`,
      items: [],
    };
  }
}

/** Tasks leg: what is open, what is overdue, what closed in the window. */
async function readTasks(
  userId: string,
  nowMs: number,
  windowStartMs: number,
): Promise<SourceReading<StatusTask>> {
  try {
    const res = await listCachedTasks(userId, { limit: 200 });
    const items: StatusTask[] = [];
    for (const t of res.tasks) {
      const completed = t.status === "completed";
      if (completed) {
        /* Only count work closed INSIDE the window. A task completed last
           quarter is not evidence this pilot is moving. */
        const done = t.completedAt ? Date.parse(t.completedAt) : NaN;
        if (Number.isNaN(done) || done < windowStartMs) continue;
      }
      const dueMs = t.dueAt ? Date.parse(t.dueAt) : NaN;
      items.push({
        id: t.id,
        title: t.title,
        dueAt: t.dueAt,
        overdue: !completed && !Number.isNaN(dueMs) && dueMs < nowMs,
        completed,
      });
    }
    return { state: "ok", detail: null, items };
  } catch (err) {
    return {
      state: "unavailable",
      detail: `The task store read failed: ${(err as Error).message}`,
      items: [],
    };
  }
}

/**
 * Take one reading across all three systems.
 *
 * The legs run in parallel and each contains its own failure, so the slowest
 * source sets the latency and no source can fail the whole call.
 */
export async function readPilotStatus(
  opts: ReadPilotStatusOpts,
): Promise<PilotStatusReading> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const nowMs = opts.nowMs ?? Date.now();
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const [calendar, documents, tasks] = await Promise.all([
    readCalendar(opts.userId, nowMs),
    readDocuments(windowStartMs),
    readTasks(opts.userId, nowMs, windowStartMs),
  ]);

  return {
    takenAt: new Date(nowMs).toISOString(),
    windowDays,
    calendar,
    documents,
    tasks,
  };
}
