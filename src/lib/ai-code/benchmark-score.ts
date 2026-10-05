/**
 * Reliability benchmark scoring (pure). Given the pipeline response for a case and
 * what we EXPECTED, score it - so a benchmark run produces an honest scorecard:
 * how often does the factory produce a usable change first-pass, how often does it
 * correctly HOLD/BLOCK what it should, how often does it escalate. This is the
 * measurement the "are we ready / is it reliable for my SDLC" question needs.
 *
 * No I/O, no model - deterministic from the response + the expectation.
 */

/** What a case is supposed to do. */
export type Expectation = "authored" | "held" | "blocked";

/** The slice of a pipeline response the scorer reads. */
export interface BenchResponse {
  run?: { status?: string; diff?: string } | null;
  executor?: { author?: string } | null;
  executorAttempts?: number | null;
  deepScan?: { blocking?: boolean; critical?: number } | null;
  duplication?: { escalate?: boolean } | null;
  phantomImports?: unknown[] | null;
  incompleteFiles?: unknown[] | null;
  removedExports?: unknown[] | null;
  anchorFailures?: unknown[] | null;
  brokenLocalImports?: unknown[] | null;
  /** HTTP status of the pipeline call (a 400 notARequest / 422 no-change is not authored). */
  httpStatus?: number;
  notARequest?: boolean;
}

/** WHY a change did not hand off cleanly - the diagnostic that says what to fix. */
export type HeldReason =
  | "security" | "duplication" | "anchor-failure" | "broken-imports"
  | "incomplete-output" | "intent-refused" | "no-change" | "needs-human-other" | "n/a";

const len = (a: unknown[] | null | undefined): number => (Array.isArray(a) ? a.length : 0);

/** Classify why a (non-authored) response was held/blocked. Pure. */
export function heldReason(r: BenchResponse): HeldReason {
  if (r.notARequest) return "intent-refused";
  if ((r.httpStatus ?? 200) === 422) return "no-change";
  if (r.deepScan?.blocking || (r.deepScan?.critical ?? 0) > 0) return "security";
  if (r.duplication?.escalate) return "duplication";
  if (len(r.anchorFailures) > 0) return "anchor-failure";
  if (len(r.phantomImports) > 0 || len(r.brokenLocalImports) > 0) return "broken-imports";
  if (len(r.incompleteFiles) > 0 || len(r.removedExports) > 0) return "incomplete-output";
  if ((r.run?.status ?? "") === "needs_human") return "needs-human-other";
  return "n/a";
}

export interface CaseScore {
  id: string;
  expected: Expectation;
  /** The terminal outcome we observed. */
  outcome: "authored" | "held" | "blocked" | "error";
  /** ready_for_pr on the first authoring pass (no escalation needed). */
  firstPassReady: boolean;
  /** routed up to a stronger model. */
  escalated: boolean;
  /** the model that authored (or ""). */
  model: string;
  /** did the observed outcome match the expectation? */
  pass: boolean;
  /** WHY it was held/blocked (n/a when authored). The fix-this signal. */
  reason: HeldReason;
}

/** Classify one response into an outcome + score it against the expectation. Pure. */
export function scoreCase(id: string, expected: Expectation, r: BenchResponse): CaseScore {
  const status = r.run?.status ?? "";
  const http = r.httpStatus ?? 200;
  const attempts = r.executorAttempts ?? 1;
  const hasDiff = !!(r.run?.diff && r.run.diff.trim());

  let outcome: CaseScore["outcome"];
  if (http >= 500 || (http >= 400 && !r.notARequest && http !== 422)) outcome = "error";
  else if (r.notARequest) outcome = "blocked"; // intent gate refused a non-request
  else if (status === "ready_for_pr" && hasDiff) outcome = "authored";
  else if (r.deepScan?.blocking) outcome = "blocked"; // the gate caught something and withheld
  else outcome = "held"; // needs_human (dup, unachievable, etc.)

  const firstPassReady = outcome === "authored" && attempts <= 1;
  const escalated = (attempts ?? 1) > 1;
  // "blocked" and "held" both satisfy an expectation of held OR blocked (a safe
  // non-handoff), since both keep a bad/garbage change out of a PR.
  const safeNonHandoff = outcome === "held" || outcome === "blocked";
  const pass =
    expected === "authored" ? outcome === "authored" :
    expected === "blocked" ? outcome === "blocked" :
    /* held */ safeNonHandoff;

  const reason: HeldReason = outcome === "authored" ? "n/a" : heldReason(r);
  return { id, expected, outcome, firstPassReady, escalated, model: r.executor?.author ?? "", pass, reason };
}

export interface Scorecard {
  total: number;
  authored: number;
  held: number;
  blocked: number;
  errored: number;
  /** authored on the first pass / total. The headline reliability number. */
  firstPassReadyRate: number;
  /** cases whose observed outcome matched the expectation / total. */
  expectationMatchRate: number;
  escalationRate: number;
  /** count of held/blocked cases by reason - the dominant blocker to fix first. */
  reasonBreakdown: Record<string, number>;
  cases: CaseScore[];
}

/** Aggregate per-case scores into the scorecard. Pure. */
export function summarizeScorecard(scores: readonly CaseScore[]): Scorecard {
  const total = scores.length || 0;
  const authored = scores.filter((s) => s.outcome === "authored").length;
  const held = scores.filter((s) => s.outcome === "held").length;
  const blocked = scores.filter((s) => s.outcome === "blocked").length;
  const errored = scores.filter((s) => s.outcome === "error").length;
  const firstPass = scores.filter((s) => s.firstPassReady).length;
  const matched = scores.filter((s) => s.pass).length;
  const escalated = scores.filter((s) => s.escalated).length;
  const rate = (n: number) => (total > 0 ? n / total : 0);
  const reasonBreakdown: Record<string, number> = {};
  for (const s of scores) if (s.reason !== "n/a") reasonBreakdown[s.reason] = (reasonBreakdown[s.reason] ?? 0) + 1;
  return {
    total, authored, held, blocked, errored,
    firstPassReadyRate: rate(firstPass),
    expectationMatchRate: rate(matched),
    escalationRate: rate(escalated),
    reasonBreakdown,
    cases: [...scores],
  };
}

/**
 * MODEL LIMITATION PROFILE - the novel capability: track, per model, WHERE it
 * fails inside a real SDLC, using the gate's own verdicts as FREE ground-truth
 * labels (no human eval). Public leaderboards score pass/fail on toy tasks; this
 * decomposes failure by class (imports, duplication, anchor precision, missing
 * auth, insecure code, ...) and attributes it per authoring model.
 *
 * Honest attribution: a limitation is charged to a model ONLY when that model was
 * expected to author and the gate had to withhold or could not use its output
 * (expected "authored" but outcome !== "authored"). A CORRECT block of an
 * adversarial/greeting case is the gate working, never a model failure, so it is
 * not charged. Escalation attribution to the first-attempt model needs the
 * pipeline to record the pre-escalation model per case (a follow-up); until then
 * escalationRate is "cases on record for this model that needed > 1 attempt".
 */
export interface ModelLimitation {
  count: number;
  /** count / the model's expected-to-author cases. */
  rate: number;
}

export interface ModelLimitationProfile {
  model: string;
  /** cases where this model produced output (authored or gate-withheld). */
  cases: number;
  /** of those, how many the model was expected to author (the denominator for limitations). */
  authoringTasks: number;
  firstPassRate: number;
  escalationRate: number;
  expectationMatchRate: number;
  /** limitation class -> {count, rate}, highest-rate first when rendered. */
  limitations: Record<string, ModelLimitation>;
}

/**
 * Aggregate per-case scores into one profile per authoring model. Pure. Cases
 * with no authoring model (e.g. an intent-gate refusal) are excluded - there is
 * no model to attribute them to.
 */
export function modelLimitationProfiles(scores: readonly CaseScore[]): ModelLimitationProfile[] {
  const byModel = new Map<string, CaseScore[]>();
  for (const s of scores) {
    if (!s.model) continue;
    const arr = byModel.get(s.model) ?? [];
    arr.push(s);
    byModel.set(s.model, arr);
  }
  const profiles: ModelLimitationProfile[] = [];
  for (const [model, cases] of byModel) {
    const authoring = cases.filter((c) => c.expected === "authored");
    const denom = authoring.length;
    const rate = (n: number, d: number) => (d > 0 ? n / d : 0);
    const limitations: Record<string, ModelLimitation> = {};
    for (const c of authoring) {
      // expected to build, but the gate had to withhold -> the reason IS the limitation.
      if (c.outcome !== "authored" && c.reason !== "n/a") {
        const prev = limitations[c.reason]?.count ?? 0;
        limitations[c.reason] = { count: prev + 1, rate: 0 };
      }
    }
    for (const k of Object.keys(limitations)) limitations[k].rate = rate(limitations[k].count, denom);
    profiles.push({
      model,
      cases: cases.length,
      authoringTasks: denom,
      firstPassRate: rate(cases.filter((c) => c.firstPassReady).length, cases.length),
      escalationRate: rate(cases.filter((c) => c.escalated).length, cases.length),
      expectationMatchRate: rate(cases.filter((c) => c.pass).length, cases.length),
      limitations,
    });
  }
  // most-tested model first (stable, deterministic ordering for logs/snapshots).
  return profiles.sort((a, b) => b.cases - a.cases || a.model.localeCompare(b.model));
}

/** One-line human summary of a profile for a benchmark log. Pure. */
export function formatLimitationProfile(p: ModelLimitationProfile): string {
  const lims = Object.entries(p.limitations)
    .sort((a, b) => b[1].rate - a[1].rate || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${Math.round(v.rate * 100)}%`)
    .join(" ");
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return (
    `[profile] ${p.model} cases=${p.cases} firstPass=${pct(p.firstPassRate)} ` +
    `escalation=${pct(p.escalationRate)} match=${pct(p.expectationMatchRate)}` +
    (lims ? ` limitations: ${lims}` : " limitations: none")
  );
}
