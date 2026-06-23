/**
 * OGIAM decision explorer: read-side queries over the ogiam_decisions ledger.
 *
 * Phase 0 runs the gate in shadow (monitor) mode: every AI action is recorded
 * with what the policy decision point WOULD have done, without blocking. These
 * queries back the admin explorer so a CTO can review that evidence stream:
 * the recent decisions and a small summary (totals, would-block count, and the
 * breakdown by risk tier and intended outcome).
 *
 * Reads only. Every query is workspace-scoped on the parameterized
 * `workspace_id` and goes through `safeQuery`, so a missing DATABASE_URL or a
 * transient DB error degrades to an empty result (fromCache=true) rather than
 * throwing into the route. The route translates that into a 503.
 */

import { safeQuery } from "@/lib/db";

/** Default page size for the decisions list. */
export const OGIAM_DECISIONS_DEFAULT_LIMIT = 100;
/** Hard cap so an unbounded ?limit can't pull the whole ledger. */
export const OGIAM_DECISIONS_MAX_LIMIT = 500;

/** The columns the explorer UI renders for a single decision. */
export interface OgiamDecisionRow {
  id: string;
  created_at: string;
  principal_agent: string;
  on_behalf_user_id: string;
  on_behalf_role: string | null;
  tool: string;
  capability: string;
  is_mutation: boolean;
  surface: string | null;
  risk_tier: string;
  intended_outcome: string;
  effective_outcome: string;
  enforced: boolean;
  would_block: boolean;
  rule_id: string;
  reason: string | null;
  policy_version: string;
}

/** Rollup the explorer header renders above the list. */
export interface OgiamDecisionSummary {
  total: number;
  would_block: number;
  by_tier: Record<string, number>;
  by_outcome: Record<string, number>;
}

/** Clamp a requested limit into [1, OGIAM_DECISIONS_MAX_LIMIT], default when absent. */
export function clampDecisionsLimit(raw: number | undefined): number {
  const n = Number.isFinite(raw) ? Number(raw) : OGIAM_DECISIONS_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), OGIAM_DECISIONS_MAX_LIMIT);
}

/**
 * Most recent decisions for a workspace, newest first.
 *
 * `wouldBlockOnly` narrows to the rows enforcement would have stopped (the
 * headline shadow-mode metric). `limit` defaults to 100 and is clamped to 500.
 */
export async function listDecisions(
  workspaceId: string,
  opts?: { limit?: number; wouldBlockOnly?: boolean },
): Promise<OgiamDecisionRow[]> {
  const limit = clampDecisionsLimit(opts?.limit);
  const wouldBlockClause = opts?.wouldBlockOnly ? " AND would_block = true" : "";

  const res = await safeQuery<OgiamDecisionRow>(
    `SELECT id,
            created_at::text AS created_at,
            principal_agent,
            on_behalf_user_id,
            on_behalf_role,
            tool,
            capability,
            is_mutation,
            surface,
            risk_tier,
            intended_outcome,
            effective_outcome,
            enforced,
            would_block,
            rule_id,
            reason,
            policy_version
       FROM ogiam_decisions
      WHERE workspace_id = $1${wouldBlockClause}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    [workspaceId],
  );

  return res.rows;
}

interface CountRow {
  total: string | number;
  would_block: string | number;
}
interface GroupRow {
  key: string;
  n: string | number;
}

function toInt(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Workspace-scoped rollup: total decisions, how many would_block, and grouped
 * counts by risk tier and by intended outcome. Three small aggregate queries,
 * each parameterized on workspace_id. Degrades to zeroes on cache/DB miss.
 */
export async function summarizeDecisions(
  workspaceId: string,
): Promise<OgiamDecisionSummary> {
  const totalsRes = await safeQuery<CountRow>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE would_block)::int AS would_block
       FROM ogiam_decisions
      WHERE workspace_id = $1`,
    [workspaceId],
  );

  const tierRes = await safeQuery<GroupRow>(
    `SELECT risk_tier AS key, COUNT(*)::int AS n
       FROM ogiam_decisions
      WHERE workspace_id = $1
      GROUP BY risk_tier`,
    [workspaceId],
  );

  const outcomeRes = await safeQuery<GroupRow>(
    `SELECT intended_outcome AS key, COUNT(*)::int AS n
       FROM ogiam_decisions
      WHERE workspace_id = $1
      GROUP BY intended_outcome`,
    [workspaceId],
  );

  const totals = totalsRes.rows[0];
  const by_tier: Record<string, number> = {};
  for (const r of tierRes.rows) by_tier[r.key] = toInt(r.n);
  const by_outcome: Record<string, number> = {};
  for (const r of outcomeRes.rows) by_outcome[r.key] = toInt(r.n);

  return {
    total: toInt(totals?.total),
    would_block: toInt(totals?.would_block),
    by_tier,
    by_outcome,
  };
}
