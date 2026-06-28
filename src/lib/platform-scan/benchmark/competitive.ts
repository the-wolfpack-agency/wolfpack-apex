/**
 * THE COMPETITIVE BENCHMARK - pure scoring of third-party free scanners against
 * the SAME consent corpus + ground truth + scorer we hold ourselves to.
 *
 * The mandate: prove to clients we find the same (and more) issues than the
 * leading free DAST/template scanners. We do that honestly by running OWASP ZAP
 * and Nuclei against the corpus, normalizing their findings into OUR taxonomy
 * (`${category}:${title}`, the same findingClass the scorer + ground truth use),
 * and scoring them with the SAME `scoreTarget` math we score ourselves with. No
 * second precision/recall implementation; this module REUSES the scorer.
 *
 * Everything here is PURE: no DB, no network, no clock. Analytics emission is the
 * only side effect and `trackEvent` is INJECTED (deps) so tests are deterministic
 * and no learning data is lost.
 *
 * HONESTY FIRST (the precision-first ethos, applied to rivals too):
 *   - The normalize mapping is documented, conservative, and one-directional: an
 *     alert/template only maps to a ground-truth class when the mapping is
 *     defensible. An unmapped competitor finding lands in OUR taxonomy under a
 *     `competitor:<tool>:<raw-id>` class so it is never silently dropped (no data
 *     lost) but also never inflates the rival's recall against ground truth.
 *   - Recall/precision for a competitor are computed by the SAME scorer over the
 *     SAME per-target ground truth, so the head-to-head is apples-to-apples.
 *   - rivalOnlyGaps are the prioritized backlog: ground-truth classes a rival
 *     matched that WE missed. parity is the proof signal: we matched/beat every
 *     rival on a target (no rival-only class).
 */

import { trackEvent } from "@/lib/analytics";
import type { ScanFinding, ScanCategory, ScanSeverity } from "../types";
import type { BenchmarkTarget } from "./corpus";
import { scoreTarget, type TargetScore } from "./scorer";
import type { BenchmarkRunRow } from "./benchmark-store";

/** The competitor scanners we benchmark. Extensible: add a tool + its mapping
 *  table below and it flows through normalize -> score -> report unchanged. */
export type CompetitorTool = "zap" | "nuclei";

/** Human label per tool, for the dashboard + audit. */
export const COMPETITOR_LABEL: Record<CompetitorTool, string> = {
  zap: "OWASP ZAP",
  nuclei: "Nuclei",
};

/** One mapping rule: a tool's native signal -> our finding taxonomy. `match` is
 *  tested against the tool-native identity (ZAP alert name, Nuclei template id or
 *  a tag) case-insensitively as a substring; first match wins. severity is the
 *  severity WE would assign so the normalized finding is shaped like ours. */
interface MappingRule {
  /** Substring (lower-cased) tested against the native identity. */
  match: string;
  category: ScanCategory;
  /** The title half of our findingClass. Combined as `${category}:${title}`. */
  title: string;
  severity: ScanSeverity;
}

/**
 * ZAP alert-name -> our taxonomy. Conservative + documented. ZAP baseline emits
 * alerts by human name (e.g. "Cross Site Scripting (Reflected)"); we map only the
 * ones that correspond to a class our ground-truth corpus actually labels, so the
 * head-to-head recall is meaningful. Anything else falls through to the honest
 * `competitor:zap:<name>` passthrough (counted as coverage, never as a GT match).
 */
const ZAP_MAPPING: MappingRule[] = [
  { match: "sql injection", category: "security", title: "SQL injection", severity: "high" },
  { match: "cross site scripting (reflected)", category: "security", title: "Reflected XSS", severity: "high" },
  { match: "cross site scripting (dom", category: "security", title: "Reflected XSS", severity: "high" },
  { match: "cross site scripting (persistent", category: "security", title: "Reflected XSS", severity: "high" },
  { match: "remote os command injection", category: "security", title: "Command injection", severity: "critical" },
  { match: "command injection", category: "security", title: "Command injection", severity: "critical" },
  { match: "xpath injection", category: "security", title: "XPath injection", severity: "high" },
  { match: "ldap injection", category: "security", title: "LDAP injection", severity: "high" },
  { match: "weak authentication", category: "security", title: "Broken authentication", severity: "high" },
  { match: "cors", category: "security", title: "CORS wildcard with credentials", severity: "medium" },
  { match: "cross-domain misconfiguration", category: "security", title: "CORS wildcard with credentials", severity: "medium" },
  { match: "weak cipher", category: "security", title: "Weak cryptography", severity: "medium" },
  { match: "weak hash", category: "security", title: "Weak cryptography", severity: "medium" },
  { match: "server side request forgery", category: "security", title: "SSRF", severity: "high" },
  { match: "ssrf", category: "security", title: "SSRF", severity: "high" },
  { match: "security misconfiguration", category: "security", title: "Security misconfiguration", severity: "medium" },
];

/**
 * Nuclei template-id / tag -> our taxonomy. Nuclei is template-driven: each match
 * carries a template-id (e.g. "CVE-..", "sqli-..") and tags (e.g. ["sqli","xss"]).
 * We map on id-or-tag substring. Same conservative discipline: only map to a class
 * the corpus labels; everything else passes through as `competitor:nuclei:<id>`.
 */
const NUCLEI_MAPPING: MappingRule[] = [
  { match: "sqli", category: "security", title: "SQL injection", severity: "high" },
  { match: "sql-injection", category: "security", title: "SQL injection", severity: "high" },
  { match: "xss", category: "security", title: "Reflected XSS", severity: "high" },
  { match: "cmdi", category: "security", title: "Command injection", severity: "critical" },
  { match: "command-injection", category: "security", title: "Command injection", severity: "critical" },
  { match: "rce", category: "security", title: "Command injection", severity: "critical" },
  { match: "xpath", category: "security", title: "XPath injection", severity: "high" },
  { match: "ldap", category: "security", title: "LDAP injection", severity: "high" },
  { match: "ssrf", category: "security", title: "SSRF", severity: "high" },
  { match: "idor", category: "security", title: "Broken object level authorization (IDOR)", severity: "high" },
  { match: "bola", category: "security", title: "Broken object level authorization (IDOR)", severity: "high" },
  { match: "cors", category: "security", title: "CORS wildcard with credentials", severity: "medium" },
  { match: "exposure", category: "security", title: "Excessive data exposure", severity: "medium" },
  { match: "misconfig", category: "security", title: "Security misconfiguration", severity: "medium" },
  { match: "weak-crypto", category: "security", title: "Weak cryptography", severity: "medium" },
  { match: "default-login", category: "security", title: "Broken authentication", severity: "high" },
];

const MAPPING_BY_TOOL: Record<CompetitorTool, MappingRule[]> = {
  zap: ZAP_MAPPING,
  nuclei: NUCLEI_MAPPING,
};

/**
 * A raw competitor finding, deliberately loose so a thin script parser can hand us
 * whatever the tool's JSON yields without pre-shaping. We read the fields each tool
 * exposes; everything is optional and defended.
 *   - ZAP baseline JSON: alert (name), riskdesc, url, plus signature variants.
 *   - Nuclei JSONL: template-id / templateID, info.name, info.tags, matched-at.
 */
export interface RawCompetitorFinding {
  /** ZAP alert name. */
  alert?: string;
  /** ZAP/Nuclei human name. */
  name?: string;
  /** Nuclei template id. */
  templateId?: string;
  /** Nuclei template id (kebab variant some versions emit). */
  "template-id"?: string;
  /** Nuclei tags. */
  tags?: string[] | string;
  /** Where it fired (route/url). */
  url?: string;
  "matched-at"?: string;
  route?: string;
  /** Free description. */
  description?: string;
}

/**
 * Derive the tool-native identity string we match against. For ZAP it is the
 * alert name; for Nuclei it is the template-id joined with its tags so either can
 * satisfy a mapping rule. Lower-cased once here so all matching is case-insensitive.
 */
function nativeIdentity(tool: CompetitorTool, raw: RawCompetitorFinding): string {
  if (tool === "zap") {
    return String(raw.alert ?? raw.name ?? "").toLowerCase();
  }
  // nuclei
  const id = String(raw.templateId ?? raw["template-id"] ?? raw.name ?? "");
  const tags = Array.isArray(raw.tags)
    ? raw.tags.join(",")
    : typeof raw.tags === "string"
      ? raw.tags
      : "";
  return `${id} ${tags}`.trim().toLowerCase();
}

/** The route/url a raw finding fired on, normalized to a non-empty string. */
function rawRoute(raw: RawCompetitorFinding): string {
  return String(raw.url ?? raw["matched-at"] ?? raw.route ?? "/").trim() || "/";
}

/**
 * Normalize a tool's raw findings into ScanFinding-shaped items whose findingClass
 * uses OUR `${category}:${title}` convention. A finding matching a mapping rule
 * adopts that rule's category+title+severity; an UNMAPPED finding is preserved
 * honestly under a `competitor` category with title `<tool>:<native-id>` so it is
 * never lost AND never silently credited as a ground-truth match (its class simply
 * will not appear in any target's groundTruth). The dedupe of class-per-route is
 * left to the scorer (it counts class occurrences), matching how we score ourselves.
 */
export function normalizeCompetitorFindings(
  tool: CompetitorTool,
  raw: RawCompetitorFinding[],
): ScanFinding[] {
  const rules = MAPPING_BY_TOOL[tool];
  const out: ScanFinding[] = [];
  for (const item of raw ?? []) {
    const identity = nativeIdentity(tool, item);
    if (!identity) continue;
    const rule = rules.find((r) => identity.includes(r.match));
    if (rule) {
      out.push({
        route: rawRoute(item),
        severity: rule.severity,
        category: rule.category,
        title: rule.title,
        detail: `Normalized from ${COMPETITOR_LABEL[tool]} finding "${identity.trim()}".`,
        evidence: { tool, native: identity.trim() },
      });
    } else {
      // Honest passthrough: keep it as coverage (no data lost) but in a class that
      // cannot collide with a ground-truth class, so it never inflates recall.
      out.push({
        route: rawRoute(item),
        severity: "low",
        category: "security",
        title: `competitor:${tool}:${identity.trim()}`,
        detail: `Unmapped ${COMPETITOR_LABEL[tool]} finding (kept as coverage, not a ground-truth match).`,
        evidence: { tool, native: identity.trim(), unmapped: true },
      });
    }
  }
  return out;
}

/** One competitor's score on one target - the SAME TargetScore the scorer produces
 *  for us, tagged with the tool so the report can lay it next to ours. */
export interface CompetitorScore {
  tool: CompetitorTool;
  target: string;
  score: TargetScore;
  findings: number;
}

/**
 * Score a competitor's findings against a target's ground truth, REUSING the
 * scorer's `scoreTarget` (no reimplemented recall/precision). The returned
 * TargetScore carries matched / missed / extra / recall exactly as it does for us.
 */
export function scoreCompetitor(
  tool: CompetitorTool,
  target: BenchmarkTarget,
  findings: ScanFinding[],
): CompetitorScore {
  return {
    tool,
    target: target.name,
    score: scoreTarget(target, findings),
    findings: findings.length,
  };
}

/** precision over a single target's score: matched / (matched + extra-on-labeled).
 *  Mirrors scoreBenchmark's precision math but for one target (the scorer only
 *  aggregates precision across a whole run, so we derive the per-target value here
 *  from the SAME inputs - matched + extra - it uses). Vacuously 1 when nothing was
 *  reported. Only meaningful on a labeled target. */
export function precisionOf(score: TargetScore): number {
  if (!score.labeled) return 1;
  const extra = score.extra.reduce((sum, e) => sum + e.count, 0);
  const denom = score.matched.length + extra;
  return denom > 0 ? score.matched.length / denom : 1;
}

/** Per-tool head-to-head row, laid next to our own numbers on the same target. */
export interface CompetitiveToolResult {
  tool: CompetitorTool;
  label: string;
  recall: number;
  precision: number;
  matched: string[];
  findings: number;
}

/** A ground-truth class a rival matched that WE missed - the prioritized backlog. */
export interface RivalOnlyGap {
  findingClass: string;
  /** Which tools matched it (>=1). */
  tools: CompetitorTool[];
}

/** The head-to-head report for ONE target. */
export interface CompetitiveReport {
  target: string;
  /** Our recall/precision on this target (from listRecentBenchmarkRuns). */
  ours: { recall: number; precision: number; matched: string[] };
  /** Per-tool head-to-head, in input order. */
  tools: CompetitiveToolResult[];
  /** Ground-truth classes a rival caught that we missed. */
  rivalOnlyGaps: RivalOnlyGap[];
  /** True when we matched or beat every tool (no rival-only class). The proof signal. */
  parity: boolean;
}

/** Our side of the head-to-head: the latest TargetScore-ish facts we hold for a
 *  target, read out of a persisted BenchmarkRunRow's report.perTarget. */
export interface OurTargetScore {
  target: string;
  recall: number;
  precision: number;
  /** Ground-truth classes WE matched on this target. */
  matched: string[];
}

/** Injected deps. trackEvent defaults to the real emitter; actor attributes events. */
export interface CompetitiveDeps {
  trackEvent: typeof trackEvent;
  actor: { id: string; role: string };
}

export const defaultCompetitiveDeps: CompetitiveDeps = {
  trackEvent,
  actor: { id: "system", role: "system" },
};

/**
 * Build the head-to-head report for one target from OUR latest score on it plus
 * the competitor scores. Emits:
 *   - platform.competitor_gap_detected, once per (tool, rival-only class): a
 *     ground-truth class the rival matched that we missed.
 *   - platform.competitive_parity_confirmed, once, when no rival-only class exists
 *     (we matched/beat every tool): the client-facing parity proof.
 *
 * No data lost: every gap is emitted; parity is emitted exactly when earned.
 */
export function buildCompetitiveReport(
  ours: OurTargetScore,
  competitorScores: CompetitorScore[],
  deps: CompetitiveDeps = defaultCompetitiveDeps,
): CompetitiveReport {
  const ourMatched = new Set(ours.matched);

  const tools: CompetitiveToolResult[] = competitorScores.map((c) => ({
    tool: c.tool,
    label: COMPETITOR_LABEL[c.tool],
    recall: c.score.recall,
    precision: precisionOf(c.score),
    matched: [...c.score.matched],
    findings: c.findings,
  }));

  // rivalOnlyGaps: union over tools of (rival matched && we missed). Dedup by
  // class, accumulate which tools caught it. Stable-sorted for determinism.
  const gapTools = new Map<string, Set<CompetitorTool>>();
  for (const c of competitorScores) {
    for (const cls of c.score.matched) {
      if (ourMatched.has(cls)) continue;
      const set = gapTools.get(cls) ?? new Set<CompetitorTool>();
      set.add(c.tool);
      gapTools.set(cls, set);
    }
  }
  const rivalOnlyGaps: RivalOnlyGap[] = [...gapTools.entries()]
    .map(([findingClass, set]) => ({ findingClass, tools: [...set].sort() }))
    .sort((a, b) => a.findingClass.localeCompare(b.findingClass));

  const parity = rivalOnlyGaps.length === 0 && competitorScores.length > 0;

  // Emit one gap event per (tool, rival-only class).
  for (const gap of rivalOnlyGaps) {
    for (const tool of gap.tools) {
      deps.trackEvent("platform.competitor_gap_detected", deps.actor.id, deps.actor.role, {
        tool,
        target: ours.target,
        finding_class: gap.findingClass,
      });
    }
  }

  // Emit parity exactly when earned (at least one tool compared, no rival-only class).
  if (parity) {
    deps.trackEvent("platform.competitive_parity_confirmed", deps.actor.id, deps.actor.role, {
      target: ours.target,
      tools_compared: competitorScores.length,
    });
  }

  return {
    target: ours.target,
    ours: { recall: ours.recall, precision: ours.precision, matched: ours.matched },
    tools,
    rivalOnlyGaps,
    parity,
  };
}

/** A point in the improvement series: one of our recent runs, oldest -> newest. */
export interface TrendPoint {
  runAt: string;
  recall: number;
  coverageClasses: number;
}

/** Our improvement over time: latest-vs-prior deltas + a short series for a
 *  sparkline. Computed from OUR recent runs (the same source the base benchmark
 *  trend uses) so "improvement over time" is the real recall trend, not a proxy. */
export interface ImprovementTrend {
  /** Oldest -> newest, so a sparkline reads left to right. */
  series: TrendPoint[];
  /** Latest run's recall (or 0 when there are no runs). */
  latestRecall: number;
  /** latest.recall - prior.recall. 0 on the first run (no prior to compare). */
  recallDelta: number;
  /** latest.coverageClasses - prior.coverageClasses. 0 on the first run. */
  coverageDelta: number;
  /** Whether there is a prior run to compare against (false on the first run). */
  hasPrior: boolean;
}

/**
 * Compute our improvement trend from recent runs. `listRecentBenchmarkRuns` returns
 * NEWEST first; we reverse to oldest-first for the sparkline series, then take the
 * latest-vs-prior deltas. First-run / no-prior edge: deltas are 0 and hasPrior is
 * false (we never fabricate an improvement we cannot measure).
 */
export function improvementTrend(ourRecentRuns: BenchmarkRunRow[]): ImprovementTrend {
  const runs = Array.isArray(ourRecentRuns) ? ourRecentRuns : [];
  if (runs.length === 0) {
    return { series: [], latestRecall: 0, recallDelta: 0, coverageDelta: 0, hasPrior: false };
  }
  // Newest-first -> oldest-first for the series.
  const oldestFirst = [...runs].reverse();
  const series: TrendPoint[] = oldestFirst.map((r) => ({
    runAt: r.runAt,
    recall: Number(r.recall) || 0,
    coverageClasses: Number(r.coverageClasses) || 0,
  }));

  const latest = runs[0];
  const prior = runs[1];
  const latestRecall = Number(latest.recall) || 0;
  const hasPrior = !!prior;
  const recallDelta = hasPrior ? latestRecall - (Number(prior.recall) || 0) : 0;
  const coverageDelta = hasPrior
    ? (Number(latest.coverageClasses) || 0) - (Number(prior.coverageClasses) || 0)
    : 0;

  return { series, latestRecall, recallDelta, coverageDelta, hasPrior };
}
