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
 * headline shadow-mode metric). `agentId` narrows to a single acting agent
 * (so an agent profile can show only its own gated actions), matched on the
 * parameterized `principal_agent`. `limit` defaults to 100 and is clamped to
 * 500.
 */
export async function listDecisions(
  workspaceId: string,
  opts?: { limit?: number; wouldBlockOnly?: boolean; agentId?: string },
): Promise<OgiamDecisionRow[]> {
  const limit = clampDecisionsLimit(opts?.limit);
  const wouldBlockClause = opts?.wouldBlockOnly ? " AND would_block = true" : "";

  /* The agent filter is always parameterized ($2) so an agent id can never be
     injected into the SQL. Absent when no agentId is supplied. */
  const params: unknown[] = [workspaceId];
  let agentClause = "";
  if (opts?.agentId) {
    params.push(opts.agentId);
    agentClause = ` AND principal_agent = $${params.length}`;
  }

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
      WHERE workspace_id = $1${wouldBlockClause}${agentClause}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );

  return res.rows;
}

/** The recorded RESULT of a governed action, joined from
 *  ogiam_action_outcomes. Null when no outcome was recorded (e.g. the action
 *  was blocked before execution, or the outcome write was skipped). */
export interface AgentActionOutcome {
  ok: boolean;
  code: string | null;
  result_redacted: string | null;
  duration_ms: number | null;
}

/**
 * One full prompt-to-response entry in a per-agent action trail: the decision
 * detail (the redacted INPUT, identity, deterministic outcome, and the
 * tamper-evident hashes) plus the recorded RESULT, joined by decision seq.
 */
export interface AgentLogEntry {
  id: string;
  seq: number;
  created_at: string;
  tool: string;
  capability: string;
  surface: string | null;
  risk_tier: string;
  intended_outcome: string;
  effective_outcome: string;
  would_block: boolean;
  rule_id: string;
  reason: string | null;
  policy_version: string;
  on_behalf_user_id: string;
  on_behalf_role: string | null;
  redacted_params: string | null;
  signals: unknown;
  params_hash: string;
  entry_hash: string;
  outcome: AgentActionOutcome | null;
}

/** Raw joined row before it is shaped into AgentLogEntry's nested outcome. */
interface AgentLogRow {
  id: string;
  seq: string | number;
  created_at: string;
  tool: string;
  capability: string;
  surface: string | null;
  risk_tier: string;
  intended_outcome: string;
  effective_outcome: string;
  would_block: boolean;
  rule_id: string;
  reason: string | null;
  policy_version: string;
  on_behalf_user_id: string;
  on_behalf_role: string | null;
  redacted_params: string | null;
  signals: unknown;
  params_hash: string;
  entry_hash: string;
  outcome_ok: boolean | null;
  outcome_code: string | null;
  outcome_result_redacted: string | null;
  outcome_duration_ms: number | null;
}

/**
 * The full per-agent action trail: each governed decision (INPUT) for the agent
 * LEFT JOINed to its recorded outcome (RESULT) by (workspace_id, decision_seq),
 * newest first, workspace-scoped and parameterized on both the workspace and the
 * acting agent. Degrades to an empty array on a missing DATABASE_URL or DB error
 * (safeQuery), so the route renders an explicit empty state rather than 500ing.
 *
 * The LEFT JOIN keeps decisions that have no outcome yet (blocked before
 * execution, or the outcome write skipped) as entries with `outcome: null`.
 */
export async function listAgentActionTrail(
  workspaceId: string,
  agentId: string,
  limit?: number,
): Promise<AgentLogEntry[]> {
  const clamped = clampDecisionsLimit(limit);

  const res = await safeQuery<AgentLogRow>(
    `SELECT d.id,
            d.seq,
            d.created_at::text AS created_at,
            d.tool,
            d.capability,
            d.surface,
            d.risk_tier,
            d.intended_outcome,
            d.effective_outcome,
            d.would_block,
            d.rule_id,
            d.reason,
            d.policy_version,
            d.on_behalf_user_id,
            d.on_behalf_role,
            d.redacted_params,
            d.signals,
            d.params_hash,
            d.entry_hash,
            o.ok              AS outcome_ok,
            o.code            AS outcome_code,
            o.result_redacted AS outcome_result_redacted,
            o.duration_ms     AS outcome_duration_ms
       FROM ogiam_decisions d
       LEFT JOIN ogiam_action_outcomes o
         ON o.workspace_id = d.workspace_id
        AND o.decision_seq = d.seq
      WHERE d.workspace_id = $1
        AND d.principal_agent = $2
      ORDER BY d.created_at DESC
      LIMIT ${clamped}`,
    [workspaceId, agentId],
  );

  return res.rows.map((r) => ({
    id: r.id,
    seq: typeof r.seq === "number" ? r.seq : Number(r.seq),
    created_at: r.created_at,
    tool: r.tool,
    capability: r.capability,
    surface: r.surface,
    risk_tier: r.risk_tier,
    intended_outcome: r.intended_outcome,
    effective_outcome: r.effective_outcome,
    would_block: r.would_block,
    rule_id: r.rule_id,
    reason: r.reason,
    policy_version: r.policy_version,
    on_behalf_user_id: r.on_behalf_user_id,
    on_behalf_role: r.on_behalf_role,
    redacted_params: r.redacted_params,
    signals: r.signals,
    params_hash: r.params_hash,
    entry_hash: r.entry_hash,
    outcome:
      r.outcome_ok === null
        ? null
        : {
            ok: r.outcome_ok,
            code: r.outcome_code,
            result_redacted: r.outcome_result_redacted,
            duration_ms: r.outcome_duration_ms,
          },
  }));
}

/** The minimal decision shape the enforcement simulator replays over. */
export interface SimDecisionRow {
  capability: string;
  tool: string;
  principal_agent: string;
  would_block: boolean;
  intended_outcome: string;
  enforced: boolean;
  risk_tier: string;
}

/** Hard cap on rows a single simulation pulls, so a candidate replay over a busy
 *  workspace can't drag the whole ledger into memory. */
export const OGIAM_SIM_MAX_ROWS = 5000;

/**
 * Decisions for a workspace within the last `windowDays`, newest first, capped.
 * Backs the enforcement simulator (a read-only "what would this policy have
 * blocked" replay). Uses the (workspace_id, created_at) index; parameterized on
 * both workspace and window; degrades to [] on cache/DB miss like its siblings.
 */
export async function listDecisionsForSimulation(
  workspaceId: string,
  windowDays: number,
): Promise<SimDecisionRow[]> {
  const days = Math.min(Math.max(Math.trunc(windowDays) || 30, 1), 365);
  const res = await safeQuery<SimDecisionRow>(
    `SELECT capability, tool, principal_agent, would_block, intended_outcome,
            enforced, risk_tier
       FROM ogiam_decisions
      WHERE workspace_id = $1
        AND created_at > NOW() - make_interval(days => $2)
      ORDER BY created_at DESC
      LIMIT ${OGIAM_SIM_MAX_ROWS}`,
    [workspaceId, days],
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
