/**
 * What a person actually gets when they use this deployment, measured.
 *
 * WHY THIS IS A CAPABILITY AND NOT A SCRIPT SOMEBODY RUNS ONCE
 *
 * Standing a deployment up for a client means answering one question: does the
 * product work HERE, against THEIR data, with THEIR connectors, right now. That
 * cannot be answered by the test suite, which runs against fixtures, nor by the
 * health probes, which prove a connector responds and say nothing about whether
 * a person gets a useful answer.
 *
 * Everything between those two is where the failures live, and until now it was
 * checked by a human opening the app and typing things.
 *
 * WHAT IT CATCHES THAT NOTHING ELSE DOES
 *
 * Found on the first manual run of this journey against production, 2026-08-29:
 *
 *   - The "ask our documents" starter prompt, which the onboarding modal
 *     describes as "search everything synced from SharePoint and answer with the
 *     source attached", returned a product tour of the Docs page instead. Every
 *     layer below it was healthy. SharePoint was connected, search worked, and
 *     the same question phrased naturally returned a real answer with a citation
 *     in 1.8 seconds. Only the journey was broken, so only a journey check could
 *     see it.
 *   - The same modal claims "each one works right now, no setup needed" while
 *     one of its six prompts answers "financials are not connected yet".
 *
 * Both are exactly what derails a client walkthrough, and neither is a bug in
 * any component.
 *
 * THE CLASSIFICATION IS THE HARD PART
 *
 * "Did it answer" is not a boolean. A refusal that explains what to connect is
 * a GOOD outcome and must not be scored as a failure, or the report cries wolf
 * on a correctly-behaving deployment. A product tour returned in place of an
 * answer looks substantive by every shallow measure: it is long, fluent, on
 * topic, and completely useless to the person who asked.
 *
 * So an answer is classified, not passed or failed, and the journey declares
 * which classification it EXPECTS. A step that expects setup guidance and gets
 * it is green.
 */

/** What kind of answer came back. */
export type AnswerKind =
  /** Real content from real data. The thing we sell. */
  | "substantive"
  /** Cannot answer yet, says why, and names the fix. A good outcome. */
  | "needs_setup"
  /** Searched and genuinely found nothing, and said so. */
  | "empty"
  /** Explained a FEATURE rather than answering the question. The silent one. */
  | "product_tour"
  /** An error, an internal name, or a stack leaked to the reader. */
  | "broken"
  /** Nothing rendered inside the budget. */
  | "no_answer";

/**
 * Phrases that mean "I cannot do this yet, here is what to connect".
 *
 * Deliberately matched on the SHAPE of the sentence rather than a list of
 * connector names, so a new integration does not silently start scoring as a
 * failure the day it is added.
 */
const NEEDS_SETUP =
  /\b(not connected|isn't connected|is not connected|connect (quickbooks|microsoft|your)|no (driver|credentials) (is |are )?configured|not configured yet)\b/i;

/** Internals that should never reach a reader. */
const LEAKED_INTERNALS =
  /\b(fetch failed|ECONNREFUSED|stack trace|parameters failed validation|undefined is not|cannot read propert|[A-Za-z_]+Error:|HTTP \d{3} |\bnull\b\s*$)/i;

/** A tour describes what a PAGE does. An answer tells you a fact. */
const PRODUCT_TOUR = /\b(what you can do|how to use it|open .{0,24} from the left|browse every|go to the .{0,20} page)\b/i;

/** Said plainly that nothing was found. */
const EMPTY = /\b(no results found|i did not find anything|nothing (was )?found)\b/i;

export interface ClassifyInput {
  answer: string;
  /** Null when nothing rendered before the budget expired. */
  latencyMs: number | null;
}

/**
 * Decide what kind of answer this is.
 *
 * ORDER MATTERS AND IS DELIBERATE. A leaked error inside an otherwise helpful
 * sentence is still a leak, so `broken` is checked before the friendly kinds.
 * `needs_setup` is checked before `product_tour` because setup guidance often
 * names a page to visit and would otherwise be misread as a tour.
 */
export function classifyAnswer({ answer, latencyMs }: ClassifyInput): AnswerKind {
  const text = (answer ?? "").trim();
  if (latencyMs === null || text.length === 0) return "no_answer";
  if (LEAKED_INTERNALS.test(text)) return "broken";
  if (NEEDS_SETUP.test(text)) return "needs_setup";
  if (EMPTY.test(text)) return "empty";
  if (PRODUCT_TOUR.test(text)) return "product_tour";
  /* Anything shorter than this is a label, not an answer. Widgets carry their
     own data and their text is deliberately brief, which is why a step backed
     by a widget should expect the widget rather than a long sentence. */
  if (text.length < 40) return "no_answer";
  return "substantive";
}

/** One thing a person would actually do on their first day. */
export interface JourneyStep {
  id: string;
  /** Typed verbatim into the assistant. */
  ask: string;
  /** What a healthy deployment returns. A step is green when it matches. */
  expect: AnswerKind[];
  /** Wall-clock ceiling. Past this the person has given up. */
  budgetMs: number;
  /** Why this step is in the journey, shown in the report. */
  because: string;
}

export interface StepResult {
  step: JourneyStep;
  kind: AnswerKind;
  latencyMs: number | null;
  answer: string;
}

export interface StepVerdict extends StepResult {
  ok: boolean;
  /** Present when it failed. One sentence a person can act on. */
  problem?: string;
}

export function judgeStep(r: StepResult): StepVerdict {
  const withinBudget = r.latencyMs !== null && r.latencyMs <= r.step.budgetMs;
  const kindOk = r.step.expect.includes(r.kind);

  if (!kindOk) {
    /* Named specifically, because "failed" sends somebody reading logs while
       "answered with a product tour" sends them to the prompt that did it. */
    const why: Record<AnswerKind, string> = {
      product_tour: "explained a feature instead of answering",
      needs_setup: "needs a connector that is not set up",
      empty: "found nothing",
      broken: "leaked an internal error to the reader",
      no_answer: "returned nothing inside the budget",
      substantive: "answered",
    };
    return { ...r, ok: false, problem: `${why[r.kind]} (expected ${r.step.expect.join(" or ")})` };
  }
  if (!withinBudget) {
    return {
      ...r,
      ok: false,
      problem: `took ${r.latencyMs}ms against a ${r.step.budgetMs}ms budget`,
    };
  }
  return { ...r, ok: true };
}

export interface JourneyReport {
  verdicts: StepVerdict[];
  passed: number;
  failed: number;
  /** Steps that failed, worst kind first, so a reader starts at the top. */
  problems: StepVerdict[];
  /** True only when every step behaved as the journey expects. */
  ready: boolean;
  slowestMs: number | null;
}

/** Worst first: a leak beats a tour beats a timeout beats slowness. */
const SEVERITY: Record<AnswerKind, number> = {
  broken: 0,
  product_tour: 1,
  no_answer: 2,
  empty: 3,
  needs_setup: 4,
  substantive: 5,
};

export function scoreJourney(results: StepResult[]): JourneyReport {
  const verdicts = results.map(judgeStep);
  const problems = verdicts
    .filter((v) => !v.ok)
    .sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || a.step.id.localeCompare(b.step.id));
  const latencies = verdicts.map((v) => v.latencyMs).filter((n): n is number => n !== null);
  return {
    verdicts,
    passed: verdicts.filter((v) => v.ok).length,
    failed: problems.length,
    problems,
    ready: problems.length === 0,
    slowestMs: latencies.length ? Math.max(...latencies) : null,
  };
}
