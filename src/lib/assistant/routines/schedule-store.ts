/**
 * Standing appointments for routines.
 *
 * The store and the sweep. The arithmetic lives in schedule.ts and is pure;
 * this is the part that touches a database and a clock, kept apart so the
 * interesting logic stays testable.
 *
 * NEVER THROWS INTO A SWEEP
 *
 * One malformed row must not stop everybody else's morning. Every function here
 * reports and returns, and the sweep counts what it could not do rather than
 * abandoning the pass.
 */
import { nextRun, type Cadence, type Schedule } from "./schedule";

export interface ScheduleRow {
  id: string;
  workspaceId: string;
  userId: string;
  command: string;
  schedule: Schedule;
  nextRunAt: Date;
  failures: number;
}

/** A schedule whose routine keeps failing is switched off rather than left to
 *  notify somebody about the same broken thing every morning. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Create or move a standing appointment. Returns the next occurrence. */
export async function upsertSchedule(
  owner: { workspaceId: string; userId: string },
  command: string,
  schedule: Schedule,
  now: Date,
): Promise<{ ok: true; nextRunAt: Date } | { ok: false; reason: string }> {
  if (!process.env.DATABASE_URL) return { ok: false, reason: "schedules cannot be saved in this environment" };
  const at = nextRun(schedule, now);
  try {
    const { query } = await import("@/lib/db");
    await query(
      `INSERT INTO assistant_routine_schedules
         (id, workspace_id, user_id, command, cadence, hour, weekday, time_zone, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (workspace_id, user_id, command) WHERE active
       DO UPDATE SET cadence     = EXCLUDED.cadence,
                     hour        = EXCLUDED.hour,
                     weekday     = EXCLUDED.weekday,
                     time_zone   = EXCLUDED.time_zone,
                     next_run_at = EXCLUDED.next_run_at,
                     /* A schedule somebody has just re-stated is one they still
                        want. Clearing the count gives a routine that broke
                        while an integration was down a fresh start, without
                        anybody needing to know the counter exists. */
                     failures    = 0`,
      [
        `${owner.workspaceId}:${owner.userId}:${command}`,
        owner.workspaceId,
        owner.userId,
        command,
        schedule.cadence,
        schedule.hour,
        schedule.weekday ?? null,
        schedule.timeZone,
        at,
      ],
    );
    return { ok: true, nextRunAt: at };
  } catch {
    return { ok: false, reason: "the schedule could not be written just now" };
  }
}

/** Stop a standing appointment. Returns whether one was actually stopped. */
export async function cancelSchedule(
  owner: { workspaceId: string; userId: string },
  command: string,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const { query } = await import("@/lib/db");
    const { rows } = await query<{ id: string }>(
      `UPDATE assistant_routine_schedules
          SET active = false
        WHERE workspace_id = $1 AND user_id = $2 AND command = $3 AND active
        RETURNING id`,
      [owner.workspaceId, owner.userId, command],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** This person's standing appointments. */
export async function listSchedules(owner: {
  workspaceId: string;
  userId: string;
}): Promise<ScheduleRow[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { query } = await import("@/lib/db");
    const { rows } = await query<Record<string, unknown>>(
      `SELECT id, workspace_id, user_id, command, cadence, hour, weekday, time_zone,
              next_run_at, failures
         FROM assistant_routine_schedules
        WHERE workspace_id = $1 AND user_id = $2 AND active
        ORDER BY next_run_at
        LIMIT 50`,
      [owner.workspaceId, owner.userId],
    );
    return rows.map(toRow);
  } catch {
    return [];
  }
}

/**
 * Everything due now.
 *
 * Bounded, because a sweep that wakes to a backlog must not try to work through
 * all of it in one request and time out having done none of it. The rest are
 * still due on the next pass.
 */
export async function dueSchedules(now: Date, limit = 50): Promise<ScheduleRow[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { query } = await import("@/lib/db");
    const { rows } = await query<Record<string, unknown>>(
      `SELECT id, workspace_id, user_id, command, cadence, hour, weekday, time_zone,
              next_run_at, failures
         FROM assistant_routine_schedules
        WHERE active AND next_run_at <= $1
        ORDER BY next_run_at
        LIMIT $2`,
      [now, limit],
    );
    return rows.map(toRow);
  } catch {
    return [];
  }
}

/**
 * Record what happened and set the next occurrence.
 *
 * ADVANCED EVEN ON FAILURE, deliberately. A schedule left pointing at a past
 * instant is due again immediately, so a routine that throws would be retried
 * on every sweep for as long as it kept failing. The failure counter is what
 * eventually stops it, and the person is told rather than being left with a
 * schedule that silently does nothing.
 */
export async function recordRun(
  row: ScheduleRow,
  outcome: "ok" | "failed",
  now: Date,
): Promise<{ deactivated: boolean }> {
  const failures = outcome === "failed" ? row.failures + 1 : 0;
  const deactivated = failures >= MAX_CONSECUTIVE_FAILURES;
  if (!process.env.DATABASE_URL) return { deactivated };
  try {
    const { query } = await import("@/lib/db");
    await query(
      `UPDATE assistant_routine_schedules
          SET last_run_at = $2, next_run_at = $3, failures = $4, active = $5
        WHERE id = $1`,
      [row.id, now, nextRun(row.schedule, now), failures, !deactivated],
    );
  } catch {
    /* A run that happened and was not recorded is better than a run that
       throws inside a sweep and stops everybody else's. */
  }
  return { deactivated };
}

function toRow(r: Record<string, unknown>): ScheduleRow {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    userId: String(r.user_id),
    command: String(r.command),
    schedule: {
      cadence: String(r.cadence) as Cadence,
      hour: Number(r.hour),
      timeZone: String(r.time_zone),
      ...(r.weekday === null || r.weekday === undefined ? {} : { weekday: Number(r.weekday) }),
    },
    nextRunAt: new Date(String(r.next_run_at)),
    failures: Number(r.failures) || 0,
  };
}
