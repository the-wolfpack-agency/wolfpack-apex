/**
 * What stops an agent running away.
 *
 * THE GAP THIS CLOSES. An agent has a role, an accountable owner and a
 * lifecycle state, so a human can pause or revoke one. Nothing stopped it on
 * its own. A misbehaving agent ran until somebody noticed, and "somebody
 * notices" is not a control a corporation can be asked to rely on: it is the
 * thing they are buying us to replace.
 *
 * PER AGENT, NOT PER WORKSPACE. A workspace budget is shared, so one runaway
 * spends everybody else's allowance before it trips anything and the first
 * symptom is unrelated work failing. A ceiling that names the agent stops the
 * agent.
 *
 * COUNTED FROM WHAT HAPPENED, INCLUDING REFUSALS. A refusal that is not
 * counted is a ceiling somebody can walk through by retrying: the loop that
 * caused the problem keeps calling, keeps being refused, and keeps not
 * counting. Every attempt is recorded.
 *
 * FAILS CLOSED. If the count cannot be read, the operation does not run. An
 * agent that keeps working when its limiter is broken is an agent with no
 * limiter, and the whole value of this is being able to say what the ceiling
 * is rather than what it usually is.
 */
import { query } from "@/lib/db";

/** Sixty an hour: above what a real task needs, below what a loop produces. */
export const DEFAULT_MAX_OPERATIONS_PER_HOUR = 60;

export type CeilingOutcome = "allowed" | "refused_over_ceiling" | "refused_unreadable";

export interface CeilingVerdict {
  allowed: boolean;
  outcome: CeilingOutcome;
  /** Operations already recorded in the window. */
  used: number;
  /** 0 means unlimited, which somebody had to set deliberately. */
  ceiling: number;
  reason: string;
}

/**
 * Test seam, for the same reason as _setContainmentStateForTests.
 *
 * The ceiling fails closed, so a suite that never provisioned an agent gets a
 * refusal — correct behaviour, and useless noise in a suite exercising the
 * executor's routing rather than its limits. The seam makes a test say out
 * loud that it is not exercising the ceiling, instead of the limiter quietly
 * having a convenient exception baked into it.
 *
 * Never set outside tests. Production has no call site for it.
 */
let overrideForTests: CeilingVerdict | null = null;

export function _setCeilingForTests(v: CeilingVerdict | null): void {
  overrideForTests = v;
}

/** A permissive verdict, for suites that are not about the ceiling. */
export const CEILING_NOT_UNDER_TEST: CeilingVerdict = {
  allowed: true,
  outcome: "allowed",
  used: 0,
  ceiling: DEFAULT_MAX_OPERATIONS_PER_HOUR,
  reason: "ceiling not under test",
};

/**
 * May this agent execute one more operation this hour?
 *
 * The check and the record are one call, so a caller cannot count an attempt
 * and then forget to record it. That gap is exactly how a limiter comes to
 * under-count the thing it exists to bound.
 */
export async function checkAndRecordOperation(args: {
  workspaceId: string;
  agentId: string;
  operation: string;
}): Promise<CeilingVerdict> {
  if (overrideForTests) return overrideForTests;
  const { workspaceId, agentId, operation } = args;
  try {
    const ceilingRow = await query<{ max_operations_per_hour: number }>(
      `SELECT max_operations_per_hour FROM instinct_agents WHERE id = $1 AND workspace_id = $2`,
      [agentId, workspaceId],
    );
    /* An agent that is not in this workspace is not an agent this workspace
       may run, and saying so is the same answer as being over the ceiling
       from the caller's point of view: it does not run. */
    if (ceilingRow.rows.length === 0) {
      return {
        allowed: false,
        outcome: "refused_unreadable",
        used: 0,
        ceiling: 0,
        reason: "no such agent in this workspace",
      };
    }
    const ceiling = Number(ceilingRow.rows[0].max_operations_per_hour);

    /* Scoped by workspace as well as by agent. The agent id was already
       checked against this workspace above, so this is belt and braces, but a
       count that reads across tenants is the shape of the bug even when this
       particular call cannot hit it: the repo-wide guardrail is right to
       refuse it, and the honest fix is the extra predicate, not an exemption. */
    const { rows } = await query<{ used: string }>(
      `SELECT count(*)::text AS used
         FROM instinct_agent_operations
        WHERE agent_id = $1
          AND workspace_id = $2
          AND executed_at > NOW() - INTERVAL '1 hour'`,
      [agentId, workspaceId],
    );
    const used = Number(rows[0]?.used ?? 0);

    /* Zero means unlimited. Deliberately not the default: somebody chose it. */
    const over = ceiling > 0 && used >= ceiling;
    const outcome: CeilingOutcome = over ? "refused_over_ceiling" : "allowed";

    await query(
      `INSERT INTO instinct_agent_operations (workspace_id, agent_id, operation, outcome)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, agentId, operation, outcome],
    );

    return {
      allowed: !over,
      outcome,
      used,
      ceiling,
      reason: over
        ? `agent has used ${used} of ${ceiling} operations this hour`
        : `${used + 1} of ${ceiling === 0 ? "unlimited" : ceiling} operations this hour`,
    };
  } catch (err) {
    /* FAILS CLOSED. An agent that keeps working when its limiter is broken is
       an agent with no limiter. */
    return {
      allowed: false,
      outcome: "refused_unreadable",
      used: 0,
      ceiling: 0,
      reason: `ceiling could not be read: ${(err as Error).message.slice(0, 80)}`,
    };
  }
}
