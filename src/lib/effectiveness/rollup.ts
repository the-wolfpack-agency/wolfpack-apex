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

const REVIEW_PAGE = 100;
const TRIP_PAGE = 100;

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
}

export interface EffectivenessDeps {
  listReviews: (workspaceId: string, limit?: number) => Promise<ReviewRecord[]>;
  listTrips: (workspaceId: string, limit?: number) => Promise<CanaryTrip[]>;
  listCanaries: (workspaceId: string) => Promise<CanaryDisplay[]>;
}

export function liveEffectivenessDeps(): EffectivenessDeps {
  return {
    listReviews: (ws, limit) => listReviews(ws, limit),
    listTrips: (ws, limit) => listCanaryTrips(ws, limit),
    listCanaries: (ws) => listCanariesForDisplay(ws),
  };
}

export async function computeEffectiveness(
  workspaceId: string,
  deps: EffectivenessDeps,
): Promise<EffectivenessReport> {
  const [reviews, trips, canaries] = await Promise.all([
    deps.listReviews(workspaceId, REVIEW_PAGE),
    deps.listTrips(workspaceId, TRIP_PAGE),
    deps.listCanaries(workspaceId),
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

  return {
    // A full page from either reader means there may be more than we counted.
    sampleCapped: reviews.length >= REVIEW_PAGE || trips.length >= TRIP_PAGE,
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
  };
}
