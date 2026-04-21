/**
 * Company-wide goals — UNIFIED contribution stream.
 *
 * Single table (`instinct_contributions`) is the source of truth for
 * everything a teammate can attach to a KR:
 *   - manual commits typed in the Friday-sync flow (source='manual')
 *   - auto-linked Microsoft 365 events (source='ms_event')
 *   - auto-linked Microsoft 365 tasks  (source='ms_task')
 *   - (reserved) future git commits     (source='commit')
 *
 * Unified-stream design choice — SINGLE TABLE (eager materialization).
 * When linkMSEntityToKR() is called we do TWO writes in sequence:
 *   1. Call U2's linkEntities() to record the L3 edge
 *      (from_entity_type='ms_event'/'ms_task',
 *       to_entity_type='company_kr', link_type='contributes_to').
 *   2. INSERT INTO instinct_contributions a row with
 *      source='ms_event'/'ms_task',
 *      external_entity_type + external_entity_id set to the MS id.
 *
 * The L3 link is the source of truth for the RELATIONSHIP; the
 * contribution row is an eager-materialized projection that keeps
 * every read path (Friday sync, per-KR stream, per-user week view)
 * a single-table SELECT.
 *
 * Trade-off vs. join-at-read: we pay one extra write on link plus a
 * partial unique index `uq_instinct_contributions_external_kr` to
 * prevent duplicates if linkMSEntityToKR() is called twice for the
 * same (KR, external entity) pair. In exchange:
 *   * getContributionsForKR()         is a single-table scan.
 *   * getWeeklyCommitments()          is a single-table scan.
 *   * getTeamCommitmentsForWeek()     is a single-table scan.
 * Join-at-read would require joining L1 (_ms_events / _ms_tasks)
 * with L3 (_entity_links) on every Friday sync — slower AND more
 * fragile (feature code MUST NOT touch L1 rows; see 078 header).
 * Documenting the trade-off instead of re-deriving it each quarter.
 *
 * NO silent data loss: writeQuery is used for all writes so that a
 * row-count mismatch, RLS discard, or trigger rollback surfaces as
 * an explicit error (see feedback_no_silent_data_loss.md).
 */

import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { linkEntities } from "@/lib/entity-links";

export type ContributionSource = "manual" | "ms_event" | "ms_task" | "commit";
export type GradedAs = "hit" | "miss" | "close";
export type MSExternalEntityType = "ms_event" | "ms_task";

export interface Contribution {
  id: string;
  user_id: string;
  kr_id: string;
  source: ContributionSource;
  external_entity_type: string | null;
  external_entity_id: string | null;
  description: string;
  committed_for_week: string | null; // YYYY-MM-DD
  committed_at: string;
  graded_as: GradedAs | null;
  graded_at: string | null;
}

// ---------------------------------------------------------------------
// Row hydration. pg returns Date objects for DATE/TIMESTAMPTZ; we
// normalize to ISO strings at the boundary so every caller sees the
// same shape.
// ---------------------------------------------------------------------

function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toDateOnly(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function hydrate(row: Record<string, unknown>): Contribution {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    kr_id: String(row.kr_id),
    source: row.source as ContributionSource,
    external_entity_type:
      row.external_entity_type == null ? null : String(row.external_entity_type),
    external_entity_id:
      row.external_entity_id == null ? null : String(row.external_entity_id),
    description: String(row.description),
    committed_for_week: toDateOnly(row.committed_for_week),
    committed_at: toIsoOrNull(row.committed_at) ?? new Date().toISOString(),
    graded_as: row.graded_as == null ? null : (row.graded_as as GradedAs),
    graded_at: toIsoOrNull(row.graded_at),
  };
}

const CONTRIBUTION_COLS = `
  id, user_id, kr_id, source, external_entity_type, external_entity_id,
  description, committed_for_week, committed_at, graded_as, graded_at
`;

// ---------------------------------------------------------------------
// Reads — all served by single-table SELECTs against
// instinct_contributions, per the eager-materialization contract above.
// ---------------------------------------------------------------------

/**
 * All contributions attached to a KR, newest first. The stream is
 * already unified: rows from every source share the same table and
 * shape. Callers can group by `source` downstream to split manual vs.
 * auto-linked for UI display.
 *
 * Range filters `since` / `until` bound `committed_at`. A missing
 * value is equivalent to "unbounded on that side."
 */
/**
 * Admin-only hard delete of a contribution. Returns the deleted row
 * id or null when missing.
 */
export async function deleteContribution(id: string): Promise<{ id: string } | null> {
  const res = await writeQuery<{ id: string }>(
    `DELETE FROM instinct_goal_contributions WHERE id = $1 RETURNING id`,
    [id],
  );
  return res.rows.length === 0 ? null : res.rows[0];
}

/**
 * Edit the description of a contribution.
 */
export async function updateContributionDescription(
  id: string,
  description: string,
): Promise<{ id: string; description: string } | null> {
  const trimmed = description.trim();
  if (!trimmed) return null;
  const res = await writeQuery<{ id: string; description: string }>(
    `UPDATE instinct_goal_contributions SET description = $2
      WHERE id = $1
      RETURNING id, description`,
    [id, trimmed],
  );
  return res.rows.length === 0 ? null : res.rows[0];
}

export async function getContributionsForKR(
  kr_id: string,
  opts: { since?: string | Date; until?: string | Date } = {},
): Promise<Contribution[]> {
  const clauses: string[] = ["kr_id = $1"];
  const params: unknown[] = [kr_id];
  if (opts.since) {
    params.push(opts.since);
    clauses.push(`committed_at >= $${params.length}`);
  }
  if (opts.until) {
    params.push(opts.until);
    clauses.push(`committed_at <= $${params.length}`);
  }
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT ${CONTRIBUTION_COLS}
       FROM instinct_contributions
      WHERE ${clauses.join(" AND ")}
      ORDER BY committed_at DESC
      LIMIT 200`,
    params,
  );
  return res.rows.map(hydrate);
}

export interface CreateManualContributionInput {
  user_id: string;
  kr_id: string;
  description: string;
  committed_for_week?: string | null;
}

/**
 * Record a manually-typed contribution. writeQuery (expectRows: 1) so
 * silent-discard surfaces as an error. Fires `goal.contribution_created`
 * with source='manual' after a successful insert.
 */
export async function createManualContribution(
  input: CreateManualContributionInput,
): Promise<Contribution> {
  const { user_id, kr_id, description } = input;
  if (!user_id) throw new Error("createManualContribution: user_id is required");
  if (!kr_id) throw new Error("createManualContribution: kr_id is required");
  if (!description || !description.trim()) {
    throw new Error("createManualContribution: description is required");
  }

  const committed_for_week = toDateOnly(input.committed_for_week ?? null);

  const { rows } = await writeQuery<Record<string, unknown>>(
    `INSERT INTO instinct_contributions
       (user_id, kr_id, source, description, committed_for_week)
     VALUES ($1, $2, 'manual', $3, $4)
     RETURNING ${CONTRIBUTION_COLS}`,
    [user_id, kr_id, description, committed_for_week],
    { expectRows: 1 },
  );

  const contribution = hydrate(rows[0]);

  trackEvent("goal.contribution_created", user_id, "unknown", {
    kr_id,
    source: "manual",
  });

  return contribution;
}

/**
 * Grading state machine:
 *   Only ACTIVE contributions can be graded. An "active" contribution
 *   is one whose `graded_as` IS NULL. Re-grading is deliberately
 *   disallowed so grading stays an append-only signal for the
 *   learning loop — the team can't quietly revise history.
 *
 * Overloads — the task spec calls gradeContribution(id, "hit"|...),
 * but the API route layer (owned by U4) calls it with an options
 * object: gradeContribution(id, { graded_as, graded_by_user_id }).
 * Both forms are supported so we don't break the U4 route contract.
 *
 * Returns null when the id doesn't exist OR was already graded.
 * Callers should surface that as "already reviewed" rather than
 * "not found" — the UI layer knows which case it's in.
 */
export async function gradeContribution(
  id: string,
  grade: GradedAs,
  userId?: string,
): Promise<Contribution | null>;
export async function gradeContribution(
  id: string,
  opts: { graded_as: GradedAs; graded_by_user_id: string },
): Promise<Contribution | null>;
export async function gradeContribution(
  id: string,
  arg: GradedAs | { graded_as: GradedAs; graded_by_user_id: string },
  positionalUserId?: string,
): Promise<Contribution | null> {
  const grade: GradedAs =
    typeof arg === "string" ? arg : arg.graded_as;
  const userId: string =
    typeof arg === "string"
      ? positionalUserId ?? "system"
      : arg.graded_by_user_id;

  if (!(["hit", "miss", "close"] as const).includes(grade)) {
    throw new Error(`gradeContribution: invalid grade '${grade}'`);
  }

  // Peek so we can distinguish "not found" vs "already graded" and
  // return null in both cases without a writeQuery throw.
  const { rows: peek } = await safeQuery<{ id: string; graded_as: string | null; kr_id: string }>(
    `SELECT id, graded_as, kr_id FROM instinct_contributions WHERE id = $1`,
    [id],
  );
  if (peek.length === 0 || peek[0].graded_as != null) return null;

  const { rows } = await writeQuery<Record<string, unknown>>(
    `UPDATE instinct_contributions
        SET graded_as = $2, graded_at = NOW()
      WHERE id = $1 AND graded_as IS NULL
      RETURNING ${CONTRIBUTION_COLS}`,
    [id, grade],
    { expectRows: 1 },
  );

  const updated = hydrate(rows[0]);

  trackEvent("goal.contribution_graded", userId, "unknown", {
    kr_id: updated.kr_id,
    result: grade,
  });

  return updated;
}

// ---------------------------------------------------------------------
// Auto-link path — MS event / task ↔ KR
// ---------------------------------------------------------------------

export interface LinkMSEntityToKRInput {
  ms_entity_type: MSExternalEntityType;
  ms_entity_id: string;
  kr_id: string;
  user_id: string;
  description?: string;
}

/**
 * Attach an MS 365 event or task to a KR. This is the auto-link path
 * that feeds the unified stream with source='ms_event' / 'ms_task'.
 *
 * Ordering (documented in module header):
 *   1. Call U2's linkEntities() to record the L3 edge
 *      (from: ms_event/ms_task, to: company_kr,
 *       link_type='contributes_to').
 *   2. INSERT INTO instinct_contributions with external_entity_*
 *      columns set. Dedup is handled by
 *      uq_instinct_contributions_external_kr — re-running the same
 *      link returns the existing contribution row instead of
 *      raising a unique-violation.
 *
 * If linkEntities() fails the function propagates the error and does
 * NOT attempt the contribution insert (no orphan projection). On
 * conflict we fetch and return the existing row.
 */
export async function linkMSEntityToKR(
  input: LinkMSEntityToKRInput,
): Promise<Contribution> {
  const { ms_entity_type, ms_entity_id, kr_id, user_id } = input;
  if (!ms_entity_id)
    throw new Error("linkMSEntityToKR: ms_entity_id is required");
  if (!kr_id) throw new Error("linkMSEntityToKR: kr_id is required");
  if (!user_id) throw new Error("linkMSEntityToKR: user_id is required");

  // Step 1: L3 link. Idempotent by design (entity-links ON CONFLICT).
  await linkEntities(
    { entity_type: ms_entity_type, entity_id: ms_entity_id },
    { entity_type: "company_kr", entity_id: kr_id },
    "contributes_to",
    { userId: user_id },
  );

  // Step 2: eager-materialized contribution row. Dedup via the
  // partial unique index on (kr_id, external_entity_type,
  // external_entity_id).
  const description =
    input.description ?? `Auto-linked ${ms_entity_type} ${ms_entity_id}`;
  const source: ContributionSource = ms_entity_type;

  const { rows } = await writeQuery<Record<string, unknown>>(
    `INSERT INTO instinct_contributions
       (user_id, kr_id, source, external_entity_type, external_entity_id, description)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (kr_id, external_entity_type, external_entity_id)
       WHERE external_entity_type IS NOT NULL AND external_entity_id IS NOT NULL
       DO NOTHING
     RETURNING ${CONTRIBUTION_COLS}`,
    [user_id, kr_id, source, ms_entity_type, ms_entity_id, description],
  );

  if (rows.length > 0) {
    trackEvent("goal.contribution_created", user_id, "unknown", {
      kr_id,
      source,
    });
    return hydrate(rows[0]);
  }

  // Already linked — fetch and return the existing row. No event
  // fires because we didn't actually create anything new.
  const existing = await safeQuery<Record<string, unknown>>(
    `SELECT ${CONTRIBUTION_COLS}
       FROM instinct_contributions
      WHERE kr_id = $1 AND external_entity_type = $2 AND external_entity_id = $3
      LIMIT 1`,
    [kr_id, ms_entity_type, ms_entity_id],
  );
  if (existing.rows.length === 0) {
    throw new Error(
      "linkMSEntityToKR: ON CONFLICT fired but no prior row found — DB state inconsistent.",
    );
  }
  return hydrate(existing.rows[0]);
}

// ---------------------------------------------------------------------
// Per-person + team weekly views (Friday sync UI)
// ---------------------------------------------------------------------

export interface WeeklyCommitmentsInput {
  user_id: string;
  /** ISO date that falls within the desired week. Callers should
   * anchor this to Monday for consistency; the DB column is DATE
   * and is compared literally. */
  week_of: string | Date;
}

/**
 * Contributions that a specific user committed to FOR the given week.
 * Returns empty list in shadow mode. Ordered by committed_at ASC so
 * older commitments appear first in the weekly review.
 */
export async function getWeeklyCommitments(
  input: WeeklyCommitmentsInput,
): Promise<Contribution[]> {
  const weekDate = toDateOnly(input.week_of);
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT ${CONTRIBUTION_COLS}
       FROM instinct_contributions
      WHERE user_id = $1 AND committed_for_week = $2
      ORDER BY committed_at ASC`,
    [input.user_id, weekDate],
  );
  return rows.map(hydrate);
}

/**
 * ALL teammates' commitments for the given week. Powers the Friday
 * sync dashboard: every row, every person. Grouping by user_id is
 * the caller's responsibility (the UI renders a per-person column).
 */
export async function getTeamCommitmentsForWeek(
  week_of: string | Date,
): Promise<Contribution[]> {
  const weekDate = toDateOnly(week_of);
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT ${CONTRIBUTION_COLS}
       FROM instinct_contributions
      WHERE committed_for_week = $1
      ORDER BY user_id ASC, committed_at ASC`,
    [weekDate],
  );
  return rows.map(hydrate);
}
