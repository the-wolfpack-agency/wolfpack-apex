/**
 * Consolidate findings by OPERATOR: group the reconstructed journeys by their
 * durable operator fingerprint into one dossier per actor, so an analyst targets
 * a bad actor once instead of triaging its probes one by one.
 *
 * HONEST ABOUT THE FINGERPRINT. The operator key is a behavioral bucket, not an
 * identity: a coarse one (a single fetch probe, no robots, no link-following) is
 * shared by many unrelated actors, so grouping under it is "likely, not proven".
 * A distinctive fingerprint (link-following / retries / a richer toolset / a
 * repeated multi-finding pattern) is much stronger. Each group carries that
 * grouping confidence so the UI never overclaims that separate probes are one
 * actor. Pure + deterministic.
 */

import { severityOf, SEVERITY_ORDER, type Severity } from "@/lib/agent-triage";

/** The minimal shape a journey must expose to be consolidated. */
export interface OperatorViewJourney {
  key: string;
  behaviorClass: string;
  confidence: "proven" | "inferred";
  firstAt: string;
  lastAt: string;
  path: string[];
  eventCount: number;
  profile: {
    operatorKey: string;
    scaffolding: { pathDiscovery: string; readsRobotsFirst: boolean };
    toolComposition: { usedTools: string[] };
    insights: Array<{ kind: string; attack?: string }>;
  };
}

export type GroupingConfidence = "distinctive" | "coarse";

export interface OperatorGroup<T extends OperatorViewJourney> {
  operatorKey: string;
  severity: Severity;
  /** Distinct behavior classes seen for this operator. */
  behaviorClasses: string[];
  findingCount: number;
  /** Union of the notable paths this operator touched across its findings. */
  paths: string[];
  /** Union of the named attack kinds (from payload-attack insights). */
  attacks: string[];
  firstSeen: string;
  lastSeen: string;
  proven: boolean;
  grouping: GroupingConfidence;
  groupingReason: string;
  journeys: T[];
}

/** A journey is "distinctive" if its scaffolding/tooling carries a discriminating
 *  feature; a bare single fetch probe is the coarse bucket everyone shares. */
function isDistinctiveJourney(j: OperatorViewJourney): boolean {
  const s = j.profile.scaffolding;
  return (
    s.pathDiscovery !== "none" ||
    s.readsRobotsFirst ||
    j.profile.toolComposition.usedTools.length > 1 ||
    j.eventCount > 1
  );
}

export function consolidateByOperator<T extends OperatorViewJourney>(journeys: readonly T[]): OperatorGroup<T>[] {
  const byOp = new Map<string, T[]>();
  for (const j of journeys) {
    const k = j.profile.operatorKey;
    const arr = byOp.get(k);
    if (arr) arr.push(j);
    else byOp.set(k, [j]);
  }

  const groups: OperatorGroup<T>[] = [];
  for (const [operatorKey, js] of byOp) {
    const severity = js
      .map(severityOf)
      .reduce((worst, s) => (SEVERITY_ORDER[s] < SEVERITY_ORDER[worst] ? s : worst), "benign" as Severity);
    const behaviorClasses = Array.from(new Set(js.map((j) => j.behaviorClass)));
    const paths = Array.from(new Set(js.flatMap((j) => j.path))).filter(Boolean);
    const attacks = Array.from(
      new Set(js.flatMap((j) => j.profile.insights.filter((i) => i.kind === "payload_attack" && i.attack).map((i) => i.attack as string))),
    );
    const firstSeen = js.map((j) => j.firstAt).filter(Boolean).sort()[0] ?? "";
    const lastSeen = js.map((j) => j.lastAt).filter(Boolean).sort().slice(-1)[0] ?? "";
    const proven = js.some((j) => j.confidence === "proven");

    // Grouping confidence: distinctive if any finding is distinctive, or if the
    // operator recurs across several findings (a repeated pattern is itself a
    // signal). Otherwise the coarse single-probe bucket.
    const distinctive = js.some(isDistinctiveJourney) || js.length >= 3;
    const grouping: GroupingConfidence = distinctive ? "distinctive" : "coarse";
    const groupingReason = distinctive
      ? js.length >= 3 && !js.some(isDistinctiveJourney)
        ? `Recurs across ${js.length} findings with the same fingerprint - a repeated pattern, stronger than a single coarse hit.`
        : "A discriminating fingerprint (link-following / retries / richer toolset / multi-request), so this grouping is comparatively strong."
      : "A coarse fingerprint (a single fetch probe, no robots, no link-following) that unrelated actors also share, so this grouping is likely, not proven.";

    groups.push({
      operatorKey, severity, behaviorClasses, findingCount: js.length, paths, attacks,
      firstSeen, lastSeen, proven, grouping, groupingReason, journeys: js,
    });
  }

  // Worst severity first; within, proven before inferred, then most recent.
  return groups.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      Number(b.proven) - Number(a.proven) ||
      b.lastSeen.localeCompare(a.lastSeen),
  );
}
