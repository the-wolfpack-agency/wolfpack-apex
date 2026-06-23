/**
 * Drift baselines + checks over the OGIAM decision ledger.
 *
 * captureBaseline snapshots an agent's behavior distribution. runDriftCheck
 * compares a recent window to the baseline, records a drift event, and when the
 * agent has drifted past the pause threshold it auto-pauses the agent (reusing
 * the lifecycle) and notifies the owner. This is how the gate keeps an agent in
 * check across model changes: the gate is constant, the behavior shift is the
 * measurable signal, and a critical shift stops the agent rather than logging it.
 */

import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { getAgent, setAgentState } from "@/lib/agents/store";
import { notify } from "@/lib/notifications/in-app";
import {
  computeBehaviorMetrics,
  type BehaviorMetrics,
  type DecisionSample,
} from "./metrics";
import { computeDrift, type DriftResult } from "./detect";

/** How many recent decisions form the "recent" window for a drift check. */
export const RECENT_WINDOW = 50;
/** Cap on the baseline sample size. */
export const BASELINE_WINDOW = 500;

/** Pull an agent's most recent OGIAM decisions as behavior samples. */
async function fetchSamples(
  agentId: string,
  workspaceId: string,
  limit: number,
): Promise<DecisionSample[]> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT tool, risk_tier, intended_outcome, would_block
       FROM ogiam_decisions
      WHERE workspace_id = $1 AND principal_agent = $2
      ORDER BY created_at DESC LIMIT $3`,
    [workspaceId, agentId, Math.min(Math.max(limit, 1), 2000)],
  );
  return res.rows.map((r) => ({
    tool: String(r.tool),
    riskTier: String(r.risk_tier),
    intendedOutcome: String(r.intended_outcome),
    wouldBlock: Boolean(r.would_block),
  }));
}

export interface AgentBaseline {
  agentId: string;
  workspaceId: string;
  metrics: BehaviorMetrics;
  decisionCount: number;
  capturedAt: string;
}

/** Capture the agent's current behavior as its baseline (upsert). */
export async function captureBaseline(
  agentId: string,
  workspaceId: string,
): Promise<AgentBaseline | null> {
  const samples = await fetchSamples(agentId, workspaceId, BASELINE_WINDOW);
  const metrics = computeBehaviorMetrics(samples);

  await writeQuery(
    `INSERT INTO instinct_agent_baselines (agent_id, workspace_id, metrics, decision_count, captured_at)
     VALUES ($1,$2,$3::jsonb,$4, NOW())
     ON CONFLICT (agent_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       metrics = EXCLUDED.metrics,
       decision_count = EXCLUDED.decision_count,
       captured_at = NOW()`,
    [agentId, workspaceId, JSON.stringify(metrics), metrics.count],
    { expectRows: 0 },
  );
  trackEvent("agent.baseline_captured", agentId, "agent", {
    agent_id: agentId,
    workspace_id: workspaceId,
    decision_count: metrics.count,
  });
  return { agentId, workspaceId, metrics, decisionCount: metrics.count, capturedAt: new Date().toISOString() };
}

export async function getBaseline(
  agentId: string,
  workspaceId: string,
): Promise<AgentBaseline | null> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT agent_id, workspace_id, metrics, decision_count, captured_at::text AS captured_at
       FROM instinct_agent_baselines WHERE agent_id = $1 AND workspace_id = $2`,
    [agentId, workspaceId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    agentId: String(r.agent_id),
    workspaceId: String(r.workspace_id),
    metrics: r.metrics as BehaviorMetrics,
    decisionCount: Number(r.decision_count),
    capturedAt: String(r.captured_at),
  };
}

export interface DriftCheckOutcome extends DriftResult {
  action: "none" | "paused";
  recent: BehaviorMetrics;
}

/**
 * Run a drift check: compare the recent window to the baseline, record an event,
 * and auto-pause + notify the owner when the agent has drifted critically.
 * Returns the outcome. Best effort on the side effects.
 */
export async function runDriftCheck(
  agentId: string,
  workspaceId: string,
): Promise<DriftCheckOutcome> {
  const baseline = await getBaseline(agentId, workspaceId);
  const recentSamples = await fetchSamples(agentId, workspaceId, RECENT_WINDOW);
  const recent = computeBehaviorMetrics(recentSamples);

  const result: DriftResult = baseline
    ? computeDrift(baseline.metrics, recent)
    : {
        verdict: "insufficient_data",
        score: 0,
        components: { blockRateDelta: 0, tierDistance: 0, toolDistance: 0 },
        shouldPause: false,
      };

  let action: "none" | "paused" = "none";
  if (result.shouldPause) {
    const agent = await getAgent(agentId, workspaceId);
    // Only pause an agent that is currently active (do not churn a paused one).
    if (agent && agent.state === "active") {
      await setAgentState(agentId, workspaceId, "paused", { userId: "system", role: "system" });
      action = "paused";
      try {
        await notify({
          userId: agent.ownerUserId,
          category: "agent",
          priority: "high",
          title: "Agent auto-paused for behavior drift",
          body: `Agent ${agentId} drifted (score ${result.score.toFixed(2)}) and was paused for your review.`,
          actionUrl: `/admin/agents/${agentId}`,
          actionLabel: "Review agent",
          source: "agent_drift",
          sourceId: agentId,
          metadata: { agent_id: agentId, score: result.score, verdict: result.verdict },
          dedup: true,
        });
      } catch {
        /* notification is best effort; the pause already stands */
      }
      trackEvent("agent.auto_paused", agentId, "agent", {
        agent_id: agentId,
        workspace_id: workspaceId,
        score: result.score,
      });
    }
  }

  try {
    await writeQuery(
      `INSERT INTO instinct_agent_drift_events
         (agent_id, workspace_id, drift_score, verdict, action, metrics)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [agentId, workspaceId, result.score, result.verdict, action, JSON.stringify(recent)],
      { expectRows: 0 },
    );
  } catch {
    /* the event log is best effort */
  }
  trackEvent("agent.drift_checked", agentId, "agent", {
    agent_id: agentId,
    workspace_id: workspaceId,
    verdict: result.verdict,
    score: result.score,
    action,
  });

  return { ...result, action, recent };
}

export interface DriftEvent {
  id: string;
  agentId: string;
  driftScore: number;
  verdict: string;
  action: string;
  createdAt: string;
}

export async function listDriftEvents(
  agentId: string,
  workspaceId: string,
  limit = 20,
): Promise<DriftEvent[]> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT id, agent_id, drift_score, verdict, action, created_at::text AS created_at
       FROM instinct_agent_drift_events
      WHERE agent_id = $1 AND workspace_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [agentId, workspaceId, Math.min(Math.max(limit, 1), 100)],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    agentId: String(r.agent_id),
    driftScore: Number(r.drift_score),
    verdict: String(r.verdict),
    action: String(r.action),
    createdAt: String(r.created_at),
  }));
}

/** Check every active agent that has a baseline (the cron sweep). */
export async function runDriftSweep(): Promise<{ checked: number; paused: number }> {
  const res = await safeQuery<{ agent_id: string; workspace_id: string }>(
    `SELECT a.id AS agent_id, a.workspace_id
       FROM instinct_agents a
       JOIN instinct_agent_baselines b ON b.agent_id = a.id
      WHERE a.state = 'active'`,
  );
  let checked = 0;
  let paused = 0;
  for (const row of res.rows) {
    try {
      const out = await runDriftCheck(String(row.agent_id), String(row.workspace_id));
      checked += 1;
      if (out.action === "paused") paused += 1;
    } catch (err) {
      console.warn(`[agent drift] check failed for ${row.agent_id}:`, (err as Error).message);
    }
  }
  return { checked, paused };
}
