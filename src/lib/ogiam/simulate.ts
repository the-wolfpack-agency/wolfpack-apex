/**
 * OGIAM enforcement simulator — "what would this policy have blocked?"
 *
 * The gate records every AI decision to the ogiam_decisions ledger with what the
 * deterministic policy WOULD have done (would_block) independent of whether it
 * actually enforced. That shadow history is a unique asset: it lets an admin test
 * a candidate enforcement posture against REAL past traffic before committing it,
 * the way you would dry-run a firewall rule. This module replays a candidate
 * enforce-set over recorded decisions and reports the blast radius. It NEVER
 * executes or mutates anything — pure analysis over the ledger.
 *
 * The core `simulate()` is a pure function over rows (trivially unit-testable);
 * `runEnforcementSimulation()` is the thin DB-backed wrapper that fetches the
 * window via the shared ledger reader (queries.ts) — no duplicate SQL.
 */
import { listDecisionsForSimulation, type SimDecisionRow } from "./queries";

export interface EnforcementCandidate {
  /** Capabilities to (additionally) enforce. A recorded decision is "newly
   *  blocked" if it would_block, was NOT already enforced, and its capability is
   *  in this set. Matched case-insensitively. */
  enforceCapabilities: string[];
}

export interface SimulationReport {
  windowDays: number;
  decisions: number;
  /** would_block AND already enforced — actions the gate blocks TODAY. */
  currentlyBlocked: number;
  /** would_block AND not enforced AND capability in the candidate set — the
   *  actions the candidate posture would NEWLY block. */
  newlyBlocked: number;
  /** Decisions the candidate does not change. */
  unaffected: number;
  candidateCapabilities: string[];
  byCapability: { capability: string; newlyBlocked: number; total: number }[];
  byAgent: { agent: string; newlyBlocked: number }[];
  /** Among newly-blocked: how many would deny vs escalate (etc). */
  byOutcome: Record<string, number>;
  /** A few representative newly-blocked decisions for the UI/preview. */
  samples: {
    capability: string;
    tool: string;
    agent: string;
    intendedOutcome: string;
    riskTier: string;
  }[];
}

const MAX_SAMPLES = 10;

/** Pure: replay a candidate enforce-set over recorded decisions. */
export function simulate(
  rows: SimDecisionRow[],
  candidate: EnforcementCandidate,
  windowDays: number,
): SimulationReport {
  const enforceSet = new Set(candidate.enforceCapabilities.map((c) => c.toLowerCase()));

  let currentlyBlocked = 0;
  let newlyBlocked = 0;
  const byCapTotal = new Map<string, number>();
  const byCapNew = new Map<string, number>();
  const byAgentNew = new Map<string, number>();
  const byOutcome: Record<string, number> = {};
  const samples: SimulationReport["samples"] = [];

  for (const r of rows) {
    byCapTotal.set(r.capability, (byCapTotal.get(r.capability) ?? 0) + 1);
    if (r.would_block && r.enforced) currentlyBlocked += 1;

    const isNewlyBlocked =
      r.would_block && !r.enforced && enforceSet.has((r.capability || "").toLowerCase());
    if (!isNewlyBlocked) continue;

    newlyBlocked += 1;
    byCapNew.set(r.capability, (byCapNew.get(r.capability) ?? 0) + 1);
    byAgentNew.set(r.principal_agent, (byAgentNew.get(r.principal_agent) ?? 0) + 1);
    byOutcome[r.intended_outcome] = (byOutcome[r.intended_outcome] ?? 0) + 1;
    if (samples.length < MAX_SAMPLES) {
      samples.push({
        capability: r.capability,
        tool: r.tool,
        agent: r.principal_agent,
        intendedOutcome: r.intended_outcome,
        riskTier: r.risk_tier,
      });
    }
  }

  const byCapability = [...byCapTotal.entries()]
    .map(([capability, total]) => ({ capability, total, newlyBlocked: byCapNew.get(capability) ?? 0 }))
    .sort((a, b) => b.newlyBlocked - a.newlyBlocked || b.total - a.total);
  const byAgent = [...byAgentNew.entries()]
    .map(([agent, n]) => ({ agent, newlyBlocked: n }))
    .sort((a, b) => b.newlyBlocked - a.newlyBlocked);

  return {
    windowDays,
    decisions: rows.length,
    currentlyBlocked,
    newlyBlocked,
    unaffected: rows.length - newlyBlocked,
    candidateCapabilities: [...enforceSet],
    byCapability,
    byAgent,
    byOutcome,
    samples,
  };
}

/** DB-backed wrapper: fetch the window via the shared ledger reader, then simulate. */
export async function runEnforcementSimulation(
  workspaceId: string,
  candidate: EnforcementCandidate,
  windowDays = 30,
): Promise<SimulationReport> {
  const days = Math.min(Math.max(Math.trunc(windowDays) || 30, 1), 365);
  const rows = await listDecisionsForSimulation(workspaceId, days);
  return simulate(rows, candidate, days);
}
