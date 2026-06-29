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
 *     rival on a target. CRITICAL: parity is measured against GROUND TRUTH, not
 *     against the rival's submission - it means OUR recall >= every rival's
 *     recall on the SAME labeled target. On an unlabeled target (no ground truth)
 *     parity is `null` (not claimable), and we never fire the parity event. A
 *     rival finding nothing must NEVER let us claim "we matched/beat every tool".
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

/** One mapping rule: a tool's native signal -> our finding taxonomy.
 *
 *  HONEST MATCHING (fix for the lossy + over-broad bug): `match` is a list of
 *  discrete TOKENS. A rule fires when ANY of its tokens equals a whole token /
 *  tag of the finding's native identity (word-boundary equality, NOT a naive
 *  substring). This kills two distortions:
 *    - over-broad: a substring like "sqli" no longer matches an unrelated id
 *      such as "sqlite-version-disclosure" (that contains "sqli" as a substring
 *      but never as a standalone token), so the rival is not over-credited.
 *    - lossy: ALL matching rules fire, not just the first - a multi-tag Nuclei
 *      finding (tags ["sqli","xss"]) maps to BOTH classes, so the rival is not
 *      deflated to one class.
 *  A multi-word token like "sql injection" is matched as a contiguous run of
 *  whole tokens (a phrase), so ZAP's human alert names still map.
 *  severity is the severity WE would assign so the normalized finding is ours. */
interface MappingRule {
  /** Discrete tokens/phrases (lower-cased). The rule fires when ANY matches the
   *  native identity as a whole token (or contiguous token phrase). */
  match: string[];
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
  { match: ["sql injection"], category: "security", title: "SQL injection", severity: "high" },
  { match: ["cross site scripting"], category: "security", title: "Reflected XSS", severity: "high" },
  { match: ["remote os command injection", "command injection"], category: "security", title: "Command injection", severity: "critical" },
  { match: ["xpath injection"], category: "security", title: "XPath injection", severity: "high" },
  { match: ["ldap injection"], category: "security", title: "LDAP injection", severity: "high" },
  { match: ["weak authentication"], category: "security", title: "Broken authentication", severity: "high" },
  { match: ["cors", "cross-domain misconfiguration"], category: "security", title: "CORS wildcard with credentials", severity: "medium" },
  { match: ["weak cipher", "weak hash"], category: "security", title: "Weak cryptography", severity: "medium" },
  { match: ["server side request forgery", "ssrf"], category: "security", title: "SSRF", severity: "high" },
  { match: ["security misconfiguration"], category: "security", title: "Security misconfiguration", severity: "medium" },
];

/**
 * Nuclei template-id / tag -> our taxonomy. Nuclei is template-driven: each match
 * carries a template-id (e.g. "CVE-..", "sqli-..") and tags (e.g. ["sqli","xss"]).
 * We map on id-or-tag substring. Same conservative discipline: only map to a class
 * the corpus labels; everything else passes through as `competitor:nuclei:<id>`.
 */
const NUCLEI_MAPPING: MappingRule[] = [
  { match: ["sqli", "sql-injection"], category: "security", title: "SQL injection", severity: "high" },
  { match: ["xss"], category: "security", title: "Reflected XSS", severity: "high" },
  { match: ["cmdi", "command-injection", "rce"], category: "security", title: "Command injection", severity: "critical" },
  { match: ["xpath"], category: "security", title: "XPath injection", severity: "high" },
  { match: ["ldap"], category: "security", title: "LDAP injection", severity: "high" },
  { match: ["ssrf"], category: "security", title: "SSRF", severity: "high" },
  { match: ["idor", "bola"], category: "security", title: "Broken object level authorization (IDOR)", severity: "high" },
  { match: ["cors"], category: "security", title: "CORS wildcard with credentials", severity: "medium" },
  { match: ["exposure"], category: "security", title: "Excessive data exposure", severity: "medium" },
  { match: ["misconfig"], category: "security", title: "Security misconfiguration", severity: "medium" },
  { match: ["weak-crypto"], category: "security", title: "Weak cryptography", severity: "medium" },
  { match: ["default-login"], category: "security", title: "Broken authentication", severity: "high" },
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
 * Split a native identity (or a mapping token) into discrete lower-case tokens.
 * Splits on any run of non-alphanumeric characters, so "generic-sqli",
 * "cross site scripting (reflected)", and "sqli-error-based" all tokenize to
 * whole words. This is what makes matching token-equality based (no substring
 * over-credit, e.g. "sqlite" tokenizes to ["sqlite"], which never equals "sqli").
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when `phraseTokens` appears as a contiguous run inside `idTokens`. A
 * single-token phrase reduces to token equality; a multi-token phrase (e.g.
 * "sql injection", "default login") must match as adjacent whole tokens. This is
 * the word-boundary discipline that replaces the old naive substring includes().
 */
function phraseMatches(idTokens: string[], phraseTokens: string[]): boolean {
  if (phraseTokens.length === 0) return false;
  for (let i = 0; i + phraseTokens.length <= idTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      if (idTokens[i + j] !== phraseTokens[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Normalize a tool's raw findings into ScanFinding-shaped items whose findingClass
 * uses OUR `${category}:${title}` convention.
 *
 * HONEST, MULTI-CLASS MAPPING (fix for lossy/over-broad bug): a single finding is
 * matched against ALL mapping rules by whole-token equality, and EVERY matching
 * rule emits a normalized finding. So a multi-tag Nuclei finding (tags
 * ["sqli","xss"]) yields BOTH security:SQL injection AND security:Reflected XSS
 * (no deflation), while an incidental substring like "sqli" inside
 * "sqlite-version" never matches (no inflation). Distinct classes per finding are
 * de-duplicated (two rules resolving to the same title emit one finding).
 *
 * An UNMAPPED finding is preserved honestly under a `competitor` category with
 * title `<tool>:<native-id>` so it is never lost AND never silently credited as a
 * ground-truth match (its class will not appear in any target's groundTruth). The
 * dedupe of class-per-route is left to the scorer (it counts class occurrences),
 * matching how we score ourselves.
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
    const idTokens = tokenize(identity);
    const route = rawRoute(item);

    // Collect EVERY rule whose token set matches; dedupe by resulting title so a
    // finding that triggers two rules mapping to the same class emits once.
    const matchedTitles = new Set<string>();
    for (const rule of rules) {
      if (matchedTitles.has(rule.title)) continue;
      const hit = rule.match.some((tok) => phraseMatches(idTokens, tokenize(tok)));
      if (!hit) continue;
      matchedTitles.add(rule.title);
      out.push({
        route,
        severity: rule.severity,
        category: rule.category,
        title: rule.title,
        detail: `Normalized from ${COMPETITOR_LABEL[tool]} finding "${identity.trim()}".`,
        evidence: { tool, native: identity.trim() },
      });
    }

    if (matchedTitles.size === 0) {
      // Honest passthrough: keep it as coverage (no data lost) but in a class that
      // cannot collide with a ground-truth class, so it never inflates recall.
      out.push({
        route,
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

/** A normalized finding's class is a competitor passthrough when it was unmapped.
 *  The full findingClass is `${category}:${title}` where the passthrough title is
 *  `competitor:<tool>:<id>`, so the class key reads e.g.
 *  "security:competitor:nuclei:banner-disclosure". These are an honest coverage
 *  record of unmapped rival output, NOT false positives - they must be excluded
 *  from the rival's precision denominator (fix #4). We detect the `competitor:`
 *  title segment, matching either the title directly or its place after the
 *  `${category}:` prefix. */
export function isCompetitorPassthroughClass(findingClass: string): boolean {
  return findingClass.startsWith("competitor:") || findingClass.includes(":competitor:");
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
 *  from the SAME inputs - matched + extra - it uses).
 *
 *  Returns `null` (NOT APPLICABLE) on an unlabeled target or when nothing scorable
 *  was reported - never a vacuous 1 that reads as "100%".
 *
 *  Fix #4: `competitor:<tool>:<id>` passthrough classes are EXCLUDED from the
 *  denominator. They are an honest coverage record of unmapped rival output, not
 *  false positives; counting them as FPs cratered a rival's precision unfairly
 *  (every unmapped ZAP/Nuclei finding looked like noise). Excluding them scores a
 *  rival's precision on the SAME basis we score our own extras. */
export function precisionOf(score: TargetScore): number | null {
  if (!score.labeled) return null;
  const extra = score.extra
    .filter((e) => !isCompetitorPassthroughClass(e.findingClass))
    .reduce((sum, e) => sum + e.count, 0);
  const denom = score.matched.length + extra;
  return denom > 0 ? score.matched.length / denom : null;
}

/** Per-tool head-to-head row, laid next to our own numbers on the same target.
 *  recall/precision are `null` when the target is unlabeled (NOT APPLICABLE). */
export interface CompetitiveToolResult {
  tool: CompetitorTool;
  label: string;
  recall: number | null;
  precision: number | null;
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
  /** Whether the target carries ground truth. parity/recall/precision are only
   *  meaningful (non-null) when true. */
  labeled: boolean;
  /** Our recall/precision on this target (from listRecentBenchmarkRuns). `null`
   *  when not applicable (unlabeled target, or we have no run for it yet). */
  ours: { recall: number | null; precision: number | null; matched: string[] };
  /** Per-tool head-to-head, in input order. */
  tools: CompetitiveToolResult[];
  /** Ground-truth classes a rival caught that we missed. */
  rivalOnlyGaps: RivalOnlyGap[];
  /**
   * The proof signal, measured against GROUND TRUTH (not the rival's submission):
   * `true` when OUR recall >= every compared rival's recall on this LABELED
   * target. `null` (NOT CLAIMABLE) when the target is unlabeled, when we have no
   * scored run for it (our recall is unknown, not 0), or when no tool was
   * compared. NEVER `true` just because a rival found nothing.
   */
  parity: boolean | null;
}

/** Our side of the head-to-head: the latest TargetScore-ish facts we hold for a
 *  target, read out of a persisted BenchmarkRunRow's report.perTarget.
 *
 *  recall/precision are `null` when NOT APPLICABLE: an unlabeled target, OR we
 *  have no scored run for the target yet (recall unknown - never silently 0).
 *  `hasRun` distinguishes "we scored it and got recall r" from "we never scored
 *  it" so parity is not claimed on a missing run. */
export interface OurTargetScore {
  target: string;
  recall: number | null;
  precision: number | null;
  /** Ground-truth classes WE matched on this target. */
  matched: string[];
  /** Whether the target carries ground truth (parity only claimable when true). */
  labeled: boolean;
  /** Whether we actually have a scored benchmark run for this target. When false,
   *  our recall is UNKNOWN (not 0) and parity is not claimable. */
  hasRun: boolean;
  /** ISO timestamp of the run our score came from, so "as of" is knowable. null
   *  when we have no run. */
  runAt: string | null;
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
 *   - platform.competitive_parity_confirmed, once, ONLY when parity is genuinely
 *     EARNED against ground truth: the client-facing parity proof.
 *
 * PARITY HONESTY (fix #1): parity is measured against GROUND TRUTH, not the
 * rival's submission. It is `true` only when ALL of:
 *   - the target is LABELED (ground truth exists to measure recall against), AND
 *   - we actually have a scored run for the target (our recall is KNOWN, not a
 *     silent 0 from a missing run), AND
 *   - at least one rival was compared, AND
 *   - there is no rival-only ground-truth gap (we matched every GT class a rival
 *     did), AND
 *   - our recall >= every compared rival's recall.
 * Otherwise parity is `null` (NOT CLAIMABLE) and the parity event never fires.
 * A rival finding nothing on an unlabeled target can no longer let us claim
 * "we matched/beat every tool".
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

  // Parity is only CLAIMABLE on a labeled target we have actually scored, with at
  // least one rival compared and our recall known. Otherwise null (not claimable).
  const claimable =
    ours.labeled &&
    ours.hasRun &&
    typeof ours.recall === "number" &&
    competitorScores.length > 0;

  let parity: boolean | null;
  if (!claimable) {
    parity = null;
  } else {
    // Ground-truth measured: no rival caught a GT class we missed AND our recall
    // is >= every compared rival's recall on the SAME labeled target. A rival with
    // null recall (unlabeled - cannot happen here since we are labeled, but defended)
    // does not count toward the max.
    const maxRivalRecall = competitorScores.reduce(
      (max, c) => (typeof c.score.recall === "number" ? Math.max(max, c.score.recall) : max),
      0,
    );
    parity = rivalOnlyGaps.length === 0 && (ours.recall as number) >= maxRivalRecall;
  }

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

  // Emit parity ONLY when genuinely earned against ground truth.
  if (parity === true) {
    deps.trackEvent("platform.competitive_parity_confirmed", deps.actor.id, deps.actor.role, {
      target: ours.target,
      tools_compared: competitorScores.length,
      // parity===true implies ours.recall is a number (claimable guard), but coerce
      // for the string|number|boolean meta type.
      our_recall: ours.recall ?? "n/a",
    });
  }

  return {
    target: ours.target,
    labeled: ours.labeled,
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
 * Compute our improvement trend from recent runs.
 *
 * Fix #6: we SORT by run_at ascending INSIDE this function rather than trusting
 * the caller's order. The previous code assumed `listRecentBenchmarkRuns` hands
 * back strict newest-first and just reversed it; if the caller's order ever
 * drifted (a tie, a different query, unsorted input), a recall DROP could render
 * as an improvement. Sorting here makes "latest" and "prior" canonical regardless
 * of input order, so the delta direction can never be inverted.
 *
 * First-run / no-prior edge: deltas are 0 and hasPrior is false (we never
 * fabricate an improvement we cannot measure). Runs with a null/unmeasurable
 * recall are treated as 0 for the trend (the aggregate recall is null only when
 * there were no labeled targets at all).
 */
export function improvementTrend(ourRecentRuns: BenchmarkRunRow[]): ImprovementTrend {
  const runs = Array.isArray(ourRecentRuns) ? ourRecentRuns : [];
  if (runs.length === 0) {
    return { series: [], latestRecall: 0, recallDelta: 0, coverageDelta: 0, hasPrior: false };
  }
  // Canonical oldest-first order by run_at (ascending). Ties keep input order.
  const oldestFirst = [...runs].sort(
    (a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime(),
  );
  const series: TrendPoint[] = oldestFirst.map((r) => ({
    runAt: r.runAt,
    recall: Number(r.recall) || 0,
    coverageClasses: Number(r.coverageClasses) || 0,
  }));

  // Latest = last oldest-first; prior = the one before it.
  const latest = oldestFirst[oldestFirst.length - 1];
  const prior = oldestFirst[oldestFirst.length - 2];
  const latestRecall = Number(latest.recall) || 0;
  const hasPrior = !!prior;
  const recallDelta = hasPrior ? latestRecall - (Number(prior.recall) || 0) : 0;
  const coverageDelta = hasPrior
    ? (Number(latest.coverageClasses) || 0) - (Number(prior.coverageClasses) || 0)
    : 0;

  return { series, latestRecall, recallDelta, coverageDelta, hasPrior };
}
