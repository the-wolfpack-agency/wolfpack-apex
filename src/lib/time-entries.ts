/**
 * Time-entries lib — persists, lists, and summarizes work hours
 * logged via the assistant's TimeLogWidget + /time page.
 *
 * Workspace-scoped: every read filters by workspace_id. Every write
 * goes through writeQuery so a silent insert is impossible.
 */

import { writeQuery, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export const MAX_NOTES_LENGTH = 500;
export const MAX_JOB_CODE_LENGTH = 64;

export interface RecordTimeEntryInput {
  workspaceId: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  jobCode: string;
  hours: number;
  notes?: string;
  /** YYYY-MM-DD; defaults to today (server-side) if omitted. */
  loggedForDate?: string;
}

export interface TimeEntry {
  id: string;
  workspace_id: string;
  user_id: string;
  user_email: string | null;
  user_role: string | null;
  job_code: string;
  hours: number;
  notes: string | null;
  logged_for_date: string;
  created_at: string;
}

/** Normalize a job code: trim + uppercase + collapse internal spaces. */
export function normalizeJobCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

export async function recordTimeEntry(
  input: RecordTimeEntryInput,
): Promise<TimeEntry> {
  const jobCode = normalizeJobCode(input.jobCode ?? "");
  if (!jobCode || jobCode.length > MAX_JOB_CODE_LENGTH) {
    throw new Error(
      `recordTimeEntry: job_code is required and must be ≤ ${MAX_JOB_CODE_LENGTH} chars`,
    );
  }
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new Error("recordTimeEntry: hours must be a number in (0, 24]");
  }
  if (!input.workspaceId) throw new Error("recordTimeEntry: workspaceId required");
  if (!input.userId) throw new Error("recordTimeEntry: userId required");
  const notes = (input.notes ?? "").trim().slice(0, MAX_NOTES_LENGTH) || null;

  /* loggedForDate validation: must look like YYYY-MM-DD. Postgres
     handles the range check; we just guard against junk strings. */
  let loggedFor = input.loggedForDate;
  if (loggedFor && !/^\d{4}-\d{2}-\d{2}$/.test(loggedFor)) {
    throw new Error("recordTimeEntry: loggedForDate must be YYYY-MM-DD");
  }
  if (!loggedFor) loggedFor = new Date().toISOString().slice(0, 10);

  const { rows } = await writeQuery<TimeEntry>(
    `INSERT INTO instinct_time_entries
        (workspace_id, user_id, user_email, user_role, job_code, hours, notes, logged_for_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date)
      RETURNING id, workspace_id, user_id, user_email, user_role, job_code,
                hours::float AS hours, notes,
                logged_for_date::text AS logged_for_date,
                created_at::text AS created_at`,
    [
      input.workspaceId,
      input.userId,
      input.userEmail ?? null,
      input.userRole ?? null,
      jobCode,
      hours,
      notes,
      loggedFor,
    ],
    { expectRows: 1 },
  );

  const row = rows[0];
  if (!row) throw new Error("recordTimeEntry: insert returned no row");

  trackEvent(
    "system.time_entry_recorded",
    input.userId,
    input.userRole ?? "unknown",
    {
      entry_id: row.id,
      job_code: jobCode,
      hours,
      logged_for_date: row.logged_for_date,
    },
  );

  return row;
}

export interface ListTimeEntriesOptions {
  workspaceId: string;
  /** When set, restrict to one user. Personal view. */
  userId?: string;
  /** Inclusive YYYY-MM-DD lower bound. */
  since?: string;
  /** Inclusive YYYY-MM-DD upper bound. */
  until?: string;
  limit?: number;
}

export async function listTimeEntries(
  opts: ListTimeEntriesOptions,
): Promise<TimeEntry[]> {
  const args: unknown[] = [opts.workspaceId];
  const where: string[] = [`workspace_id = $1`];
  if (opts.userId) {
    args.push(opts.userId);
    where.push(`user_id = $${args.length}`);
  }
  if (opts.since && /^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    args.push(opts.since);
    where.push(`logged_for_date >= $${args.length}::date`);
  }
  if (opts.until && /^\d{4}-\d{2}-\d{2}$/.test(opts.until)) {
    args.push(opts.until);
    where.push(`logged_for_date <= $${args.length}::date`);
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);

  const res = await safeQuery<TimeEntry>(
    `SELECT id, workspace_id, user_id, user_email, user_role, job_code,
            hours::float AS hours, notes,
            logged_for_date::text AS logged_for_date,
            created_at::text AS created_at
     FROM instinct_time_entries
     WHERE ${where.join(" AND ")}
     ORDER BY logged_for_date DESC, created_at DESC
     LIMIT ${limit}`,
    args,
  );
  return res.rows;
}

export interface TimeSummaryBucket {
  user_id: string;
  user_email: string | null;
  user_role: string | null;
  job_code: string;
  total_hours: number;
  entry_count: number;
}

export async function summarizeTimeEntries(opts: {
  workspaceId: string;
  since?: string;
  until?: string;
}): Promise<TimeSummaryBucket[]> {
  const args: unknown[] = [opts.workspaceId];
  const where: string[] = [`workspace_id = $1`];
  if (opts.since && /^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
    args.push(opts.since);
    where.push(`logged_for_date >= $${args.length}::date`);
  }
  if (opts.until && /^\d{4}-\d{2}-\d{2}$/.test(opts.until)) {
    args.push(opts.until);
    where.push(`logged_for_date <= $${args.length}::date`);
  }
  const res = await safeQuery<TimeSummaryBucket>(
    `SELECT user_id,
            (ARRAY_AGG(user_email ORDER BY created_at DESC))[1] AS user_email,
            (ARRAY_AGG(user_role  ORDER BY created_at DESC))[1] AS user_role,
            job_code,
            SUM(hours)::float AS total_hours,
            COUNT(*)::int AS entry_count
     FROM instinct_time_entries
     WHERE ${where.join(" AND ")}
     GROUP BY user_id, job_code
     ORDER BY total_hours DESC`,
    args,
  );
  return res.rows;
}
