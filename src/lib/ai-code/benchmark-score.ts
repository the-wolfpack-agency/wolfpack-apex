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
  deepScan?: { blocking?: boolean } | null;
  duplication?: { escalate?: boolean } | null;
  /** HTTP status of the pipeline call (a 400 notARequest / 422 no-change is not authored). */
  httpStatus?: number;
  notARequest?: boolean;
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

  return { id, expected, outcome, firstPassReady, escalated, model: r.executor?.author ?? "", pass };
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
  return {
    total, authored, held, blocked, errored,
    firstPassReadyRate: rate(firstPass),
    expectationMatchRate: rate(matched),
    escalationRate: rate(escalated),
    cases: [...scores],
  };
}
