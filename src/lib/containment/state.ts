/**
 * Reading the stop, and counting what a run has spent (migration 227).
 *
 * budget.ts can decide whether a run may take another step. It had nothing to
 * read the answer from, which is the same "control with no caller" gap the
 * egress allowlist had. This is the half that makes the decision reachable.
 *
 * FAIL-CLOSED IS THE WHOLE POINT
 *
 * Every read here reports whether it SUCCEEDED, separately from what it found.
 * `readable: false` is not `agentsEnabled: false` — one means the switch says
 * stop, the other means we could not ask. decideStep treats both as stop, and
 * that is deliberate: a delayed run costs minutes, a run that should have been
 * halted costs whatever the agent does next.
 *
 * Nothing here throws into a caller. A database that is unreachable produces an
 * unreadable state, not an exception in the middle of an agent step.
 *
 * Every query filters workspace_id explicitly, per the repo-wide
 * tenant-isolation scan.
 */
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { ContainmentState, RunBudget, RunSpend } from "./budget";

/**
 * Test seam.
 *
 * The executor gate fails closed, which is correct in production and makes the
 * executor untestable without a database: with no DB every read is unreadable,
 * so every step is refused and every existing executor test fails.
 *
 * The alternative — treating "no DATABASE_URL" as "containment not applicable"
 * — would be a convenient exception that is indistinguishable, at the point of
 * the check, from a database that has just gone down. That is precisely the
 * hole this control exists to close, so the seam is explicit instead: a test
 * says out loud that it is not exercising containment.
 *
 * Never set outside tests. Production has no call site for it, and CLAUDE.md
 * makes DATABASE_URL a deployment blocker, so the shadow case cannot occur
 * there anyway.
 */
let overrideForTests: ContainmentState | null = null;

export function _setContainmentStateForTests(state: ContainmentState | null): void {
  overrideForTests = state;
}

/**
 * Is agent work permitted in this workspace?
 *
 * A MISSING row reads as unreadable rather than as enabled. Migration 227
 * inserts the default workspace explicitly for that reason: absence and
 * permission are different, and only one of them is safe to assume.
 */
export async function readContainmentState(workspaceId: string): Promise<ContainmentState> {
  if (overrideForTests) return overrideForTests;
  try {
    const { rows } = await safeQuery<{ agents_enabled: boolean }>(
      `SELECT agents_enabled FROM instinct_agent_containment WHERE workspace_id = $1`,
      [workspaceId],
    );
    if (rows.length === 0) return { agentsEnabled: false, readable: false };
    return { agentsEnabled: rows[0].agents_enabled === true, readable: true };
  } catch {
    return { agentsEnabled: false, readable: false };
  }
}

/**
 * Halt or resume agent work for a workspace.
 *
 * Recorded with a reason and an actor, because whoever finds agent work stopped
 * needs to know whether to start it again, and "someone turned it off at some
 * point" does not answer that.
 */
export async function setAgentsEnabled(
  workspaceId: string,
  enabled: boolean,
  actor: { userId: string; role: string; reason?: string },
): Promise<void> {
  await safeQuery(
    `INSERT INTO instinct_agent_containment (workspace_id, agents_enabled, stopped_reason, stopped_by, stopped_at, updated_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $2 THEN NULL ELSE NOW() END, NOW())
     ON CONFLICT (workspace_id) DO UPDATE
        SET agents_enabled = EXCLUDED.agents_enabled,
            stopped_reason = EXCLUDED.stopped_reason,
            stopped_by     = EXCLUDED.stopped_by,
            stopped_at     = CASE WHEN EXCLUDED.agents_enabled THEN NULL ELSE NOW() END,
            updated_at     = NOW()`,
    [workspaceId, enabled, enabled ? null : (actor.reason ?? "no reason given"), actor.userId],
  );
  trackEvent(enabled ? "containment.agents_resumed" : "containment.agents_stopped", actor.userId, actor.role, {
    workspace_id: workspaceId,
    reason: (actor.reason ?? "").slice(0, 200),
  });
}

/** Open the ledger for a run, recording the ceiling it was given. */
export async function startRunSpend(
  workspaceId: string,
  runId: string,
  agentId: string | null,
  budget: RunBudget,
): Promise<void> {
  await safeQuery(
    `INSERT INTO instinct_agent_run_spend (run_id, workspace_id, agent_id, budget)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (run_id) DO UPDATE SET budget = EXCLUDED.budget, updated_at = NOW()`,
    [runId, workspaceId, agentId, JSON.stringify(budget)],
  );
}

/**
 * What this run has spent.
 *
 * An unreadable ledger returns NaN rather than zero. decideStep treats a
 * non-finite figure as unreadable and pauses, which is the correct reading: an
 * unknown spend is not a spend of nothing, and zeroing it would hand a run an
 * unlimited budget precisely when the database is unhealthy.
 */
let spendOverrideForTests: RunSpend | null = null;

/** Test seam, for the same reason as _setContainmentStateForTests. */
export function _setRunSpendForTests(spend: RunSpend | null): void {
  spendOverrideForTests = spend;
}

export async function readRunSpend(workspaceId: string, runId: string): Promise<RunSpend> {
  if (spendOverrideForTests) return spendOverrideForTests;
  const unreadable: RunSpend = { tokens: Number.NaN, durationMs: Number.NaN, egressCalls: Number.NaN, spendCents: Number.NaN };
  try {
    const { rows } = await safeQuery<{ tokens: number; duration_ms: number; egress_calls: number; spend_cents: number }>(
      `SELECT tokens, duration_ms, egress_calls, spend_cents
         FROM instinct_agent_run_spend
        WHERE workspace_id = $1 AND run_id = $2`,
      [workspaceId, runId],
    );
    if (rows.length === 0) return unreadable;
    const r = rows[0];
    return {
      tokens: Number(r.tokens),
      durationMs: Number(r.duration_ms),
      egressCalls: Number(r.egress_calls),
      spendCents: Number(r.spend_cents),
    };
  } catch {
    return unreadable;
  }
}

/** Add to a run's spend. Additive so concurrent steps cannot lose each other's
 *  usage the way a read-modify-write would. */
export async function addRunSpend(workspaceId: string, runId: string, delta: Partial<RunSpend>): Promise<void> {
  await safeQuery(
    `UPDATE instinct_agent_run_spend
        SET tokens       = tokens       + $3,
            duration_ms  = duration_ms  + $4,
            egress_calls = egress_calls + $5,
            spend_cents  = spend_cents  + $6,
            updated_at   = NOW()
      WHERE workspace_id = $1 AND run_id = $2`,
    [
      workspaceId,
      runId,
      Math.max(0, Math.round(delta.tokens ?? 0)),
      Math.max(0, Math.round(delta.durationMs ?? 0)),
      Math.max(0, Math.round(delta.egressCalls ?? 0)),
      Math.max(0, Math.round(delta.spendCents ?? 0)),
    ],
  );
}

/** Record which ceiling stopped a run, so "are our budgets set right, or are
 *  they just stopping real work" is answerable from data. */
export async function markBreached(workspaceId: string, runId: string, breached: string): Promise<void> {
  await safeQuery(
    `UPDATE instinct_agent_run_spend SET breached = $3, updated_at = NOW()
      WHERE workspace_id = $1 AND run_id = $2`,
    [workspaceId, runId, breached],
  );
}
