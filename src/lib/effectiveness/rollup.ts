/**
 * Effectiveness rollup - the "prove it works" numbers for Secure Agent and
 * Forcefield, aggregated from the SAME authoritative records an operator already
 * sees (the ai-code review store, the OGIAM canary-trip ledger, the canary
 * registry). No new event, no second source of truth: the marketing evidence and
 * the operational record are the same rows.
 *
 * TRUTHFUL BY CONSTRUCTION (the platform-scan audit invariants applied here):
 *   - Counts only. No fabricated rates. A rate over zero governed changes is
 *     reported as null ("n/a"), never 100%.
 *   - `sampleCapped` is set when a reader returned its full page, so a number is
 *     never presented as a complete total when it might be a lower bound.
 *   - "governed" (every change that ran the gate) is kept distinct from
 *     "blocked"/"contained" (what was actually stopped), so the story cannot
 *     overclaim.
 *
 * The side-effect readers are injected so the aggregation is unit-testable with
 * no DB; `liveEffectivenessDeps()` wires the real ones.
 */
import { listReviews, type ReviewRecord } from "@/lib/ai-code/store";
import { listCanaryTrips, type CanaryTrip } from "@/lib/forcefield/triage";
import { listCanariesForDisplay, type CanaryDisplay } from "@/lib/forcefield/canary-store";
import { listDecisions, type OgiamDecisionRow } from "@/lib/ogiam/queries";
import { monthSpendUsd } from "@/lib/ai/workspace-policy";
import { listEnforcementDenials, emptyEnforcementDenials, type EnforcementDenials } from "./enforcement";

const REVIEW_PAGE = 100;
const TRIP_PAGE = 100;
const DECISION_PAGE = 200;

export interface EffectivenessReport {
  /** True when a reader hit its page size, so a count is a lower bound. */
  sampleCapped: boolean;
  secureAgent: {
    changesGoverned: number;
    blocked: number;
    sentToHuman: number;
    allowed: number;
    /** Findings on changes the gate did NOT allow (what it caught in bad code). */
    risksCaught: number;
  };
  forcefield: {
    decoysActive: number;
    trips: number;
    /** Distinct agents that a decoy touch actually contained (enforced). */
    agentsContained: number;
  };
  /* Per-action governance: every agent tool call that ran the OGIAM gate. This
     is the primary governance seam and the largest execution record, so it is
     the biggest single body of marketing evidence and fine-tune ground truth. */
  governance: {
    /** Every agent action authorized through the gate (allow + the rest). */
    actionsGoverned: number;
    denied: number;
    escalated: number;
    transformed: number;
    allowed: number;
    /** Monitor-mode signal: actions enforcement WOULD have stopped (deny or
     *  escalate) had the workspace been in enforce mode. Distinct from what was
     *  actually stopped, so a shadow deployment cannot be read as an enforcing one. */
    wouldBlock: number;
    /** Distinct agents that acted through the gate. */
    agentsActive: number;
  };
  /* COGS: what the governed AI actually cost. Month-to-date only, actual spend,
     no fabricated savings rate. 0 when nothing was spent or the cost view is
     unreadable (fail-open, same posture as the budget governor). */
  cost: {
    monthToDateUsd: number;
    /** False when the cost view could not be read, so a 0 is not misread as
     *  "no spend" when it might be "not measured". */
    measured: boolean;
  };
  /* Downstream enforcement: agent actions actually STOPPED after the gate
     authorized them - the capability gate, connector-scope, the ops/hour
     ceiling, and the conduct self-tamper gate. These live in the event log, not
     the ogiam_decisions ledger, so they are counted separately here. */
  enforcement: EnforcementDenials;
}

export interface EffectivenessDeps {
  listReviews: (workspaceId: string, limit?: number) => Promise<ReviewRecord[]>;
  listTrips: (workspaceId: string, limit?: number) => Promise<CanaryTrip[]>;
  listCanaries: (workspaceId: string) => Promise<CanaryDisplay[]>;
  listDecisions: (workspaceId: string, limit: number) => Promise<OgiamDecisionRow[]>;
  /** Month-to-date AI spend for the workspace, or null when the cost view is
   *  unreadable (so the report can say "not measured" rather than "$0"). */
  monthSpend: (workspaceId: string) => Promise<number | null>;
  listEnforcement: (workspaceId: string) => Promise<EnforcementDenials>;
}

export function liveEffectivenessDeps(): EffectivenessDeps {
  return {
    listReviews: (ws, limit) => listReviews(ws, limit),
    listTrips: (ws, limit) => listCanaryTrips(ws, limit),
    listCanaries: (ws) => listCanariesForDisplay(ws),
    listDecisions: (ws, limit) => listDecisions(ws, { limit }),
    // monthSpendUsd fails OPEN to 0; we cannot distinguish that from a real 0
    // here, so a thrown error (only) becomes null ("not measured").
    monthSpend: async (ws) => {
      try {
        return await monthSpendUsd(ws);
      } catch {
        return null;
      }
    },
    listEnforcement: (ws) => listEnforcementDenials(ws),
  };
}

export async function computeEffectiveness(
  workspaceId: string,
  deps: EffectivenessDeps,
): Promise<EffectivenessReport> {
  const [reviews, trips, canaries, decisions, monthSpend, enforcement] = await Promise.all([
    deps.listReviews(workspaceId, REVIEW_PAGE),
    deps.listTrips(workspaceId, TRIP_PAGE),
    deps.listCanaries(workspaceId),
    deps.listDecisions(workspaceId, DECISION_PAGE),
    deps.monthSpend(workspaceId),
    deps.listEnforcement(workspaceId),
  ]);

  const blocked = reviews.filter((r) => r.outcome === "block").length;
  const sentToHuman = reviews.filter((r) => r.outcome === "escalate").length;
  const allowed = reviews.filter((r) => r.outcome === "allow").length;
  // Risks caught: findings on any change the gate did NOT allow. Findings on an
  // allowed change are not "caught bad code", so they are deliberately excluded.
  const risksCaught = reviews
    .filter((r) => r.outcome !== "allow")
    .reduce((n, r) => n + (r.findingCount || 0), 0);

  const containedAgents = new Set(trips.filter((t) => t.contained).map((t) => t.agent));

  // Per-action governance, counted by the gate's own effective outcome.
  const denied = decisions.filter((d) => d.effective_outcome === "deny").length;
  const escalated = decisions.filter((d) => d.effective_outcome === "escalate").length;
  const transformed = decisions.filter((d) => d.effective_outcome === "transform").length;
  const allowedActions = decisions.filter((d) => d.effective_outcome === "allow").length;
  const wouldBlock = decisions.filter((d) => d.would_block).length;
  const agentsActive = new Set(decisions.map((d) => d.principal_agent)).size;

  return {
    // A full page from ANY reader means there may be more than we counted.
    sampleCapped:
      reviews.length >= REVIEW_PAGE ||
      trips.length >= TRIP_PAGE ||
      decisions.length >= DECISION_PAGE,
    secureAgent: {
      changesGoverned: reviews.length,
      blocked,
      sentToHuman,
      allowed,
      risksCaught,
    },
    forcefield: {
      decoysActive: canaries.filter((c) => c.active).length,
      trips: trips.length,
      agentsContained: containedAgents.size,
    },
    governance: {
      actionsGoverned: decisions.length,
      denied,
      escalated,
      transformed,
      allowed: allowedActions,
      wouldBlock,
      agentsActive,
    },
    cost: {
      monthToDateUsd: monthSpend ?? 0,
      measured: monthSpend !== null,
    },
    enforcement: enforcement ?? emptyEnforcementDenials(),
  };
}
