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
import { matchProbePath, type ProbeCategory, type ProbeSeverity } from "@/lib/agent-probe-signatures";
import { stableHash } from "@/lib/agent-dossier";

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

/** Worst-first rank so a category's severity is the worst path it contains. */
const PROBE_SEV_RANK: Record<ProbeSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** One attack category this operator targeted, with its worst severity + how
 *  many distinct paths in it. Drawn from the reused AgenticQA probe signatures. */
export interface TargetingCategory {
  category: ProbeCategory;
  severity: ProbeSeverity;
  count: number;
}

/** The richer, DESCRIPTIVE granularity for an operator (task A): what it targets
 *  (attack categories), what payloads it throws, and how fast it moves. Pure
 *  description layered on the existing coarse fingerprint - it changes nothing
 *  about grouping, so the blocklist + persisted history are untouched. */
export interface TargetingSignature {
  categories: TargetingCategory[];
  payloadTypes: string[];
  topSeverity: ProbeSeverity | "none";
  cadence: { findings: number; spanHours: number; perDay: number };
  summary: string;
}

/** A distinguishable targeting profile WITHIN one coarse operator bucket (task
 *  B): finer identity without changing the durable operator key. The coarse
 *  `operatorKey` stays the anchor for the blocklist and cross-day history; a
 *  `fingerprint` of `<operatorKey>.<hash>` subdivides the bucket only when the
 *  targeting signal actually differs, so a thin single-fetch bucket does not
 *  fragment. More than one sub-actor means "this fingerprint covers several
 *  distinguishable targeting profiles" - never a claim of separate real people. */
export interface SubActor<T extends OperatorViewJourney> {
  fingerprint: string;
  findingCount: number;
  categories: ProbeCategory[];
  payloadTypes: string[];
  pathDiscovery: string;
  journeys: T[];
}

/** Categories a single set of paths targets, worst-severity-first. */
function categoriesOf(paths: readonly string[]): TargetingCategory[] {
  const byCat = new Map<ProbeCategory, TargetingCategory>();
  for (const p of paths) {
    const sig = matchProbePath(p);
    if (!sig) continue;
    const cur = byCat.get(sig.category);
    if (cur) {
      cur.count += 1;
      if (PROBE_SEV_RANK[sig.severity] > PROBE_SEV_RANK[cur.severity]) cur.severity = sig.severity;
    } else {
      byCat.set(sig.category, { category: sig.category, severity: sig.severity, count: 1 });
    }
  }
  return Array.from(byCat.values()).sort(
    (a, b) => PROBE_SEV_RANK[b.severity] - PROBE_SEV_RANK[a.severity] || b.count - a.count || a.category.localeCompare(b.category),
  );
}

/** Build the descriptive targeting signature (A) for one operator group. */
function deriveTargeting(
  paths: readonly string[],
  payloadTypes: readonly string[],
  firstSeen: string,
  lastSeen: string,
  findingCount: number,
): TargetingSignature {
  const categories = categoriesOf(paths);
  const topSeverity: ProbeSeverity | "none" = categories[0]?.severity ?? "none";
  const first = Date.parse(firstSeen);
  const last = Date.parse(lastSeen);
  const spanHours =
    Number.isFinite(first) && Number.isFinite(last) && last > first
      ? Math.round(((last - first) / 3_600_000) * 10) / 10
      : 0;
  // Under a day of span reads as a single-day burst; otherwise normalize to /day.
  const perDay =
    spanHours >= 24 ? Math.round((findingCount / (spanHours / 24)) * 10) / 10 : findingCount;
  const parts: string[] = [];
  if (categories.length) parts.push(`targets ${categories.map((c) => `${c.category} (${c.count})`).join(", ")}`);
  if (payloadTypes.length) parts.push(`throws ${payloadTypes.join(", ")}`);
  parts.push(
    spanHours >= 24
      ? `${findingCount} finding${findingCount === 1 ? "" : "s"} over ${Math.round(spanHours / 24)}d (~${perDay}/day)`
      : `${findingCount} finding${findingCount === 1 ? "" : "s"} within a day`,
  );
  return { categories, payloadTypes: [...payloadTypes], topSeverity, cadence: { findings: findingCount, spanHours, perDay }, summary: parts.join(" · ") };
}

/** Cluster one coarse group's journeys into distinguishable targeting profiles
 *  (B). The sub-key folds in what the durable key deliberately omits - the
 *  target categories, payload types, and path-discovery strategy - so two
 *  different actors sharing a coarse bucket separate, WITHOUT changing the
 *  coarse key. */
function subActorsOf<T extends OperatorViewJourney>(operatorKey: string, journeys: readonly T[]): SubActor<T>[] {
  const byFp = new Map<string, SubActor<T>>();
  for (const j of journeys) {
    const cats = Array.from(new Set(categoriesOf(j.path).map((c) => c.category))).sort();
    const payloads = Array.from(
      new Set(j.profile.insights.filter((i) => i.kind === "payload_attack" && i.attack).map((i) => i.attack as string)),
    ).sort();
    const pd = j.profile.scaffolding.pathDiscovery;
    const tools = [...j.profile.toolComposition.usedTools].sort().join(",");
    const input = `${operatorKey}|cat:${cats.join("+")}|pl:${payloads.join("+")}|pd:${pd}|tools:${tools}`;
    const fingerprint = `${operatorKey}.${stableHash(input)}`;
    const cur = byFp.get(fingerprint);
    if (cur) {
      cur.findingCount += 1;
      cur.journeys.push(j);
      for (const c of cats) if (!cur.categories.includes(c)) cur.categories.push(c);
      for (const p of payloads) if (!cur.payloadTypes.includes(p)) cur.payloadTypes.push(p);
    } else {
      byFp.set(fingerprint, { fingerprint, findingCount: 1, categories: [...cats], payloadTypes: [...payloads], pathDiscovery: pd, journeys: [j] });
    }
  }
  return Array.from(byFp.values()).sort((a, b) => b.findingCount - a.findingCount || a.fingerprint.localeCompare(b.fingerprint));
}

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
  /** Descriptive granularity (A): categories targeted, payloads, cadence. */
  targeting: TargetingSignature;
  /** Distinguishable targeting profiles inside this coarse bucket (B). */
  subActors: SubActor<T>[];
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

    const targeting = deriveTargeting(paths, attacks, firstSeen, lastSeen, js.length);
    const subActors = subActorsOf(operatorKey, js);

    groups.push({
      operatorKey, severity, behaviorClasses, findingCount: js.length, paths, attacks,
      firstSeen, lastSeen, proven, grouping, groupingReason, targeting, subActors, journeys: js,
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
