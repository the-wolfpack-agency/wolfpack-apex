/**
 * Model-version regression evals over the analytics event stream.
 *
 * The producer side already exists: the task executor stamps `model_id` on every
 * agent.task_completed event (src/lib/agents/tasks/executor.ts). This module is
 * the pure consumer of that signal. It groups an agent's completed tasks by
 * model, computes the task-success rate per model, orders the models by
 * most-recent use, and (via src/lib/agents/evals/model-eval.ts) compares the
 * newest model against the one before it. A meaningful verdict (regressed |
 * improved) is persisted to instinct_agent_model_regressions (migration 221);
 * every check emits agent.model_evaluated so the learning loop sees the eval,
 * and a regression additionally audits, notifies the owner, and emits
 * agent.model_regression_detected.
 *
 * Unlike behavior drift, a model regression does NOT auto-pause the agent: the
 * agent is not misbehaving, the swapped-in model got worse. The right response
 * is a human deciding whether to roll the model back, so the outcome is a
 * high-priority notification and an audit entry, not a lifecycle change.
 *
 * Workspace scoping: instinct_events carries no workspace_id, but agent ids are
 * globally unique, so per-agent queries are scoped by agent id and the set of
 * agents is drawn from instinct_agents WHERE workspace_id = $1 (matching the
 * drift sweep). Every read that returns rows to a caller filters by
 * workspace_id, so tenant isolation holds.
 */

import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { getAgent } from "@/lib/agents/store";
import { notify } from "@/lib/notifications/in-app";
import { recordAudit } from "@/lib/audit-log";
import {
  evaluateModelRegression,
  makeSuccessRate,
  type ModelEvalResult,
  type ModelStats,
} from "./model-eval";

/** Cap on rows scanned per grouping query, a backstop on a hot event table. */
const MAX_MODELS = 50;

/** One raw per-(agent, model) outcome row from the event stream. */
interface OutcomeRow {
  agent_id: string;
  model: string;
  total: number;
  succeeded: number;
  last_seen: string;
}

/** Turn recency-ordered raw rows for ONE agent into ranked ModelStats. */
function toModelStats(rows: OutcomeRow[]): ModelStats[] {
  return rows.map((r, i) => ({
    model: r.model,
    total: Number(r.total),
    succeeded: Number(r.succeeded),
    successRate: makeSuccessRate(Number(r.succeeded), Number(r.total)),
    recencyRank: i,
  }));
}

/**
 * Per-model task outcomes for a single agent, most-recently-used model first.
 * Reads agent.task_completed events, keyed on the model_id already stamped on
 * each. `blocked` and `failed` both count as not-succeeded (only the honest
 * `succeeded` terminal state counts), so a model that raises the block rate or
 * the failure rate lowers the success rate either way.
 */
export async function fetchModelOutcomes(agentId: string): Promise<ModelStats[]> {
  const res = await safeQuery<OutcomeRow>(
    `SELECT metadata->>'model_id'                                            AS model,
            COUNT(*)::int                                                    AS total,
            COUNT(*) FILTER (WHERE metadata->>'status' = 'succeeded')::int   AS succeeded,
            MAX(timestamp)::text                                             AS last_seen
       FROM instinct_events
      WHERE event_type = 'agent.task_completed'
        AND user_id = $1
        AND metadata->>'model_id' IS NOT NULL
      GROUP BY metadata->>'model_id'
      ORDER BY MAX(timestamp) DESC
      LIMIT $2`,
    [agentId, MAX_MODELS],
  );
  return toModelStats(res.rows.map((r) => ({ ...r, agent_id: agentId })));
}

/**
 * Per-model outcomes for EVERY active agent in a workspace, in one query.
 * Returns a map of agentId -> recency-ordered ModelStats. Used by the fleet
 * standings read so the ops panel is one round-trip, not one per agent.
 */
export async function fetchWorkspaceModelOutcomes(
  workspaceId: string,
): Promise<Map<string, ModelStats[]>> {
  const res = await safeQuery<OutcomeRow>(
    `SELECT e.user_id                                                          AS agent_id,
            e.metadata->>'model_id'                                            AS model,
            COUNT(*)::int                                                      AS total,
            COUNT(*) FILTER (WHERE e.metadata->>'status' = 'succeeded')::int   AS succeeded,
            MAX(e.timestamp)::text                                             AS last_seen
       FROM instinct_events e
       JOIN instinct_agents a
         ON a.id = e.user_id AND a.workspace_id = $1 AND a.state = 'active'
      WHERE e.event_type = 'agent.task_completed'
        AND e.metadata->>'model_id' IS NOT NULL
      GROUP BY e.user_id, e.metadata->>'model_id'
      ORDER BY e.user_id, MAX(e.timestamp) DESC`,
    [workspaceId],
  );

  const byAgent = new Map<string, OutcomeRow[]>();
  for (const row of res.rows) {
    const list = byAgent.get(row.agent_id) ?? [];
    list.push(row);
    byAgent.set(row.agent_id, list);
  }

  const out = new Map<string, ModelStats[]>();
  for (const [agentId, rows] of byAgent) out.set(agentId, toModelStats(rows));
  return out;
}

export interface ModelEvalOutcome extends ModelEvalResult {
  /** True when a row was written to the regression ledger. */
  persisted: boolean;
}

/**
 * Evaluate one agent, persist a meaningful verdict, and fire the side effects.
 * Best effort on every side effect: the eval result is returned even if a write
 * or notification fails. Never throws.
 */
export async function runModelEvalCheck(
  agentId: string,
  workspaceId: string,
): Promise<ModelEvalOutcome> {
  const stats = await fetchModelOutcomes(agentId);
  const result = evaluateModelRegression(stats);

  // Every eval is a learning signal, even a stable one.
  trackEvent("agent.model_evaluated", agentId, "agent", {
    agent_id: agentId,
    workspace_id: workspaceId,
    verdict: result.verdict,
    candidate_model: result.candidateModel ?? "",
    baseline_model: result.baselineModel ?? "",
    delta: Number(result.delta.toFixed(4)),
    candidate_samples: result.candidateSamples,
    baseline_samples: result.baselineSamples,
  });

  let persisted = false;
  if (
    (result.verdict === "regressed" || result.verdict === "improved") &&
    result.candidateModel &&
    result.baselineModel
  ) {
    try {
      await writeQuery(
        `INSERT INTO instinct_agent_model_regressions
           (agent_id, workspace_id, baseline_model, candidate_model,
            baseline_success_rate, candidate_success_rate, delta,
            baseline_samples, candidate_samples, verdict)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          agentId,
          workspaceId,
          result.baselineModel,
          result.candidateModel,
          result.baselineSuccessRate,
          result.candidateSuccessRate,
          result.delta,
          result.baselineSamples,
          result.candidateSamples,
          result.verdict,
        ],
        { expectRows: 0 },
      );
      persisted = true;
    } catch (err) {
      console.warn(
        `[model-eval] persist failed for ${agentId}:`,
        (err as Error).message,
      );
    }
  }

  if (result.verdict === "regressed") {
    trackEvent("agent.model_regression_detected", agentId, "agent", {
      agent_id: agentId,
      workspace_id: workspaceId,
      candidate_model: result.candidateModel ?? "",
      baseline_model: result.baselineModel ?? "",
      delta: Number(result.delta.toFixed(4)),
    });

    // Model regressions are security/quality relevant: a governed principal got
    // measurably worse after a model swap. Hash-chain it. Best effort.
    try {
      await recordAudit({
        actor: { user_id: "system", role: "system" },
        action: "agent.model_regression_detected",
        resourceType: "agent",
        resourceId: agentId,
        afterState: {
          workspace_id: workspaceId,
          baseline_model: result.baselineModel,
          candidate_model: result.candidateModel,
          delta: result.delta,
        },
      });
    } catch (err) {
      console.warn(
        `[model-eval] audit failed for ${agentId}:`,
        (err as Error).message,
      );
    }

    // Notify the accountable owner so a human decides on a rollback. No
    // auto-pause: the agent is not misbehaving, its model regressed.
    try {
      const agent = await getAgent(agentId, workspaceId);
      if (agent) {
        const dropPts = Math.round(Math.abs(result.delta) * 100);
        await notify({
          userId: agent.ownerUserId,
          category: "agent",
          priority: "high",
          title: "Agent task success dropped after a model change",
          body: `${agent.name} succeeds ${dropPts} points less on ${result.candidateModel} than on ${result.baselineModel}. Review whether to roll the model back.`,
          actionUrl: `/admin/agents/${agentId}`,
          actionLabel: "Review agent",
          source: "agent_model_eval",
          sourceId: agentId,
          metadata: {
            agent_id: agentId,
            candidate_model: result.candidateModel ?? "",
            baseline_model: result.baselineModel ?? "",
            delta: result.delta,
          },
          dedup: true,
        });
      }
    } catch {
      /* notification is best effort; the audit + ledger row already stand */
    }
  }

  return { ...result, persisted };
}

/** Check every active agent in the fleet (the cron sweep). Never throws. */
export async function runModelEvalSweep(): Promise<{
  checked: number;
  regressed: number;
}> {
  const res = await safeQuery<{ agent_id: string; workspace_id: string }>(
    `SELECT id AS agent_id, workspace_id
       FROM instinct_agents
      WHERE state = 'active'`,
  );
  let checked = 0;
  let regressed = 0;
  for (const row of res.rows) {
    try {
      const out = await runModelEvalCheck(
        String(row.agent_id),
        String(row.workspace_id),
      );
      checked += 1;
      if (out.verdict === "regressed") regressed += 1;
    } catch (err) {
      console.warn(
        `[model-eval] check failed for ${row.agent_id}:`,
        (err as Error).message,
      );
    }
  }
  return { checked, regressed };
}

export interface ModelRegressionRecord {
  id: string;
  agentId: string;
  baselineModel: string;
  candidateModel: string;
  baselineSuccessRate: number;
  candidateSuccessRate: number;
  delta: number;
  baselineSamples: number;
  candidateSamples: number;
  verdict: string;
  createdAt: string;
}

/** Recent persisted regression/improvement events for a workspace. */
export async function listModelRegressions(
  workspaceId: string,
  limit = 20,
): Promise<ModelRegressionRecord[]> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT id, agent_id, baseline_model, candidate_model,
            baseline_success_rate, candidate_success_rate, delta,
            baseline_samples, candidate_samples, verdict,
            created_at::text AS created_at
       FROM instinct_agent_model_regressions
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [workspaceId, Math.min(Math.max(limit, 1), 100)],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    agentId: String(r.agent_id),
    baselineModel: String(r.baseline_model),
    candidateModel: String(r.candidate_model),
    baselineSuccessRate: Number(r.baseline_success_rate),
    candidateSuccessRate: Number(r.candidate_success_rate),
    delta: Number(r.delta),
    baselineSamples: Number(r.baseline_samples),
    candidateSamples: Number(r.candidate_samples),
    verdict: String(r.verdict),
    createdAt: String(r.created_at),
  }));
}

export interface AgentModelStanding {
  agentId: string;
  agentName: string;
  verdict: ModelEvalResult["verdict"];
  candidateModel: string | null;
  baselineModel: string | null;
  candidateSuccessRate: number;
  baselineSuccessRate: number;
  delta: number;
  candidateSamples: number;
  baselineSamples: number;
}

/**
 * Current live model-eval standing for every active agent in the workspace that
 * has enough data to evaluate (verdict != insufficient_data). Read-only: this
 * computes standings for display and does NOT persist or fire side effects (the
 * cron sweep owns that). One query for the whole fleet.
 */
export async function getFleetModelStandings(
  workspaceId: string,
): Promise<AgentModelStanding[]> {
  const outcomes = await fetchWorkspaceModelOutcomes(workspaceId);
  if (outcomes.size === 0) return [];

  // Names for display. Scoped to the workspace; only active agents matter.
  const nameRes = await safeQuery<{ id: string; name: string }>(
    `SELECT id, name FROM instinct_agents
      WHERE workspace_id = $1 AND state = 'active'`,
    [workspaceId],
  );
  const names = new Map<string, string>();
  for (const row of nameRes.rows) names.set(String(row.id), String(row.name));

  const standings: AgentModelStanding[] = [];
  for (const [agentId, stats] of outcomes) {
    const result = evaluateModelRegression(stats);
    if (result.verdict === "insufficient_data") continue;
    standings.push({
      agentId,
      agentName: names.get(agentId) ?? agentId,
      verdict: result.verdict,
      candidateModel: result.candidateModel,
      baselineModel: result.baselineModel,
      candidateSuccessRate: result.candidateSuccessRate,
      baselineSuccessRate: result.baselineSuccessRate,
      delta: result.delta,
      candidateSamples: result.candidateSamples,
      baselineSamples: result.baselineSamples,
    });
  }

  // Worst regressions first (most negative delta), then the rest.
  standings.sort((a, b) => a.delta - b.delta);
  return standings;
}
