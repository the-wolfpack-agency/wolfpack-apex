/**
 * Attribution dossier - fuse everything we observe about an agent into one
 * evidence bundle, keyed to a consistent OPERATOR across surfaces.
 *
 * The pieces on their own are signals: the behavior journey (what it did on a
 * surface), the scaffolding signature (how it is built), the tool composition
 * (what it is equipped to do). Fused, and correlated across the surfaces we
 * protect, they become attribution-grade evidence: "one operator, this behavior,
 * this tooling, seen on these surfaces." The operator key is derived from the
 * DURABLE, operator-chosen signals (its scaffolding strategy + its toolset) -
 * not the model, which is swappable, and not PII.
 *
 * THE HONEST LIMIT, ENCODED. This attributes behavior to a consistent operator
 * PROFILE. It does NOT establish a real-world identity - that needs legal
 * process (subpoena, ISP records), which is not ours to claim. The dossier is
 * what you hand a security team or an investigator; the `disclaimer` field says
 * so in every dossier so the claim can never quietly inflate. And the proven vs
 * inferred rail carries all the way through: the fusion is only as strong as its
 * strongest proven evidence, and it says which is which.
 */

import type { AgentJourney } from "@/lib/agent-behavior";
import type { ScaffoldingSignature } from "@/lib/agent-probe";
import type { ToolCompositionReport, PolicyCategory } from "@/lib/agent-tool-composition";

/** One observation of an agent on one surface. */
export interface Sighting {
  surface: string;
  at: string;
  journey: AgentJourney;
  scaffolding: ScaffoldingSignature;
  tools: ToolCompositionReport;
}

export type ThreatLevel = "benign" | "elevated" | "hostile";

export interface AttributionDossier {
  /** Durable, non-PII operator fingerprint (scaffolding strategy + toolset). The
   *  same operator reusing its tooling clusters here even across models/sites. */
  operatorKey: string;
  surfaces: string[];
  sightingCount: number;
  threatLevel: ThreatLevel;
  intent: string;
  confidence: "proven" | "inferred";
  behaviorClasses: string[];
  policies: PolicyCategory[];
  /** Plain, checkable statements of what was observed. */
  evidence: string[];
  firstSeen: string;
  lastSeen: string;
  summary: string;
  /** The honest scope limit, on every dossier. */
  disclaimer: string;
}

export const DISCLAIMER =
  "Attributes behavior to a consistent operator profile across surfaces. Does NOT establish a real-world identity, which requires legal process (subpoena / ISP records). This is attribution-grade evidence for a security team or investigator, not an identification.";

const HOSTILE_CLASSES: ReadonlySet<string> = new Set(["aggressive_scraper", "vuln_scanner", "form_spammer"]);

/** Derive the operator key from the operator's durable CHOICES: how its
 *  scaffolding discovers paths + the sorted set of tools it brought. Not the
 *  model, not any PII - just the tooling posture an operator carries between
 *  jobs. Same non-crypto stable hash used elsewhere; it is a bucket, not a
 *  secret. */
export function operatorKeyFor(scaffolding: ScaffoldingSignature, tools: ToolCompositionReport): string {
  const toolSig = [...tools.usedTools].sort().join(",");
  const input = `${scaffolding.pathDiscovery}|robotsFirst:${scaffolding.readsRobotsFirst}|${toolSig}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `op_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Build a dossier from one operator's sightings. Callers group sightings by
 * operatorKeyFor first; this assumes the sightings belong to one operator (it
 * uses the first sighting's key and does not re-cluster).
 */
export function buildDossier(sightings: readonly Sighting[]): AttributionDossier {
  if (sightings.length === 0) throw new Error("buildDossier requires at least one sighting");
  const sorted = [...sightings].sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0];
  const operatorKey = operatorKeyFor(first.scaffolding, first.tools);

  const surfaces = Array.from(new Set(sorted.map((s) => s.surface)));
  const behaviorClasses = Array.from(new Set(sorted.map((s) => s.journey.behaviorClass)));
  const policies = Array.from(new Set(sorted.flatMap((s) => s.tools.policies)));

  // Proven wins: a single proven-hostile behavior or an exercised malicious tool
  // combination anywhere makes the whole dossier proven-hostile.
  const provenHostileBehavior = sorted.some(
    (s) => s.journey.confidence === "proven" && HOSTILE_CLASSES.has(s.journey.behaviorClass),
  );
  const provenMaliciousTools = sorted.some((s) => s.tools.confidence === "proven");
  const anyHostileBehavior = sorted.some((s) => HOSTILE_CLASSES.has(s.journey.behaviorClass));
  const anyDangerousTools = sorted.some((s) => s.tools.riskTier === "dangerous");
  const anyNovelTools = sorted.some((s) => s.tools.novelTools.length > 0);

  let threatLevel: ThreatLevel;
  let confidence: "proven" | "inferred";
  if (provenHostileBehavior || provenMaliciousTools) {
    threatLevel = "hostile";
    confidence = "proven";
  } else if (anyHostileBehavior || anyDangerousTools || anyNovelTools) {
    threatLevel = "elevated";
    confidence = "inferred";
  } else {
    threatLevel = "benign";
    confidence = sorted.every((s) => s.journey.confidence === "proven") ? "proven" : "inferred";
  }

  // Intent: prefer an exercised malicious-tool intent, else the strongest
  // hostile behavior class, else benign.
  const toolIntent = sorted.find((s) => s.tools.confidence === "proven")?.tools.intent;
  const behaviorIntent = sorted.find((s) => HOSTILE_CLASSES.has(s.journey.behaviorClass))?.journey.behaviorClass;
  const intent = toolIntent ?? behaviorIntent ?? "benign";

  const evidence = buildEvidence(sorted, { anyNovelTools });

  return {
    operatorKey,
    surfaces,
    sightingCount: sorted.length,
    threatLevel,
    intent,
    confidence,
    behaviorClasses,
    policies,
    evidence,
    firstSeen: sorted[0].at,
    lastSeen: sorted[sorted.length - 1].at,
    summary: summarize({ threatLevel, confidence, intent, surfaces, operatorKey }),
    disclaimer: DISCLAIMER,
  };
}

function buildEvidence(sightings: readonly Sighting[], flags: { anyNovelTools: boolean }): string[] {
  const ev: string[] = [];
  ev.push(`Seen on ${new Set(sightings.map((s) => s.surface)).size} surface(s), ${sightings.length} sighting(s).`);
  for (const s of sightings) {
    const conf = s.journey.confidence === "proven" ? "proven" : "likely";
    ev.push(`[${s.surface}] ${s.journey.behaviorClass.replace(/_/g, " ")} (${conf}); path: ${s.journey.path.join(" -> ") || "(none)"}.`);
  }
  const scaff = sightings[0].scaffolding;
  ev.push(`Scaffolding: ${scaff.pathDiscovery}${scaff.readsRobotsFirst ? ", reads robots first" : ""}${scaff.probedSensitive ? ", probes sensitive paths" : ""}.`);
  const combos = Array.from(new Set(sightings.flatMap((s) => s.tools.maliciousCombinations.map((c) => c.intent))));
  if (combos.length) ev.push(`Malicious tool combinations exercised: ${combos.join(", ")}.`);
  if (flags.anyNovelTools) {
    const novel = Array.from(new Set(sightings.flatMap((s) => s.tools.novelTools)));
    ev.push(`Novel (unrecognized) tools carried: ${novel.join(", ")}.`);
  }
  return ev;
}

function summarize(x: { threatLevel: ThreatLevel; confidence: "proven" | "inferred"; intent: string; surfaces: string[]; operatorKey: string }): string {
  const tail = x.confidence === "proven" ? "This is proven, not a guess." : "This is a likely match on a behavioral fingerprint, not confirmed.";
  if (x.threatLevel === "hostile") {
    return `One operator (${x.operatorKey}) behaving as ${x.intent.replace(/_/g, " ")} across ${x.surfaces.length} surface(s). ${tail}`;
  }
  if (x.threatLevel === "elevated") {
    return `One operator (${x.operatorKey}) showing elevated-risk capability or behavior across ${x.surfaces.length} surface(s). ${tail}`;
  }
  return `One operator (${x.operatorKey}) behaving benignly. ${tail}`;
}

/** Group a flat list of sightings into per-operator dossiers, most-recent first. */
export function buildDossiers(sightings: readonly Sighting[]): AttributionDossier[] {
  const byOperator = new Map<string, Sighting[]>();
  for (const s of sightings) {
    const k = operatorKeyFor(s.scaffolding, s.tools);
    const arr = byOperator.get(k) ?? [];
    arr.push(s);
    byOperator.set(k, arr);
  }
  return Array.from(byOperator.values())
    .map(buildDossier)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
