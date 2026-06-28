/**
 * Tier-2 journey-friction classifier for the platform-scan feature.
 *
 * Tier-1 (classifyPage in ./classify.ts) answers "is THIS page broken?" from a
 * single page-load observation. Tier-2 answers a different question: "how many
 * steps does it take to complete a task, and where do users get stuck?" The unit
 * of input here is not a page but a JOURNEY TRACE - the ordered sequence of
 * gated browser actions an agent took while attempting one goal end to end.
 *
 * THE openclaw DRIVER CONTRACT (what feeds this classifier)
 * --------------------------------------------------------
 * The agentic driver (openclaw, behind the gate-as-a-service) is a SEPARATE
 * build. THIS file is the deterministic, server-side contract it targets, so it
 * is testable and safe NOW with no agent dependency. The driver's loop is:
 *
 *   1. The driver is given a goal on a target route (e.g. "create an invoice"
 *      on /billing).
 *   2. For EACH browser action it wants to take (navigate / observe / click /
 *      fill / submit), it PROPOSES that action to authorizeBrowserAction (the
 *      gate in ./gate.ts). The agent NEVER acts ungated: the gate DECIDES,
 *      EXECUTES via the executor on allow, and AUDITS every decision to the
 *      hash-chained ledger. A blocked action is not performed.
 *   3. The driver records ONE JourneyStep per gated action - the action name,
 *      whether it succeeded (ok), and optionally how long it took (ms).
 *   4. When the goal is reached (or the driver gives up), it assembles a
 *      JourneyTrace and POSTs it to /api/admin/platform-scans/ingest under
 *      body.traces[], alongside (or instead of) observations[]/findings[].
 *   5. The ingest route runs classifyJourney on each trace SERVER-SIDE and the
 *      resulting ScanFindings flow through the SAME recordScan pipeline as every
 *      other finding (dedup, auto-resolve, Brain ingest, analytics). No data is
 *      lost: every trace becomes findings or a clean (empty) result.
 *
 * classifyJourney is a PURE function: same trace in, same findings out. It never
 * touches a browser, the gate, or the network - the gate already ran (per
 * action) by the time a trace exists. This file only turns the recorded trace
 * into friction findings. Severity and thresholds are precision-first
 * (conservative) and documented at each detector so a noisy false positive never
 * reaches the review UI.
 *
 * Findings reuse the shared ScanFinding model and category "ux_gap" - a journey
 * that dead-ends or drags is a usability gap, and it belongs in the same review
 * bucket and learning loop as the page-level UX detectors. No new ScanCategory
 * is introduced (which would ripple through types.ts / store / gate, none of
 * which this task touches).
 */

import type { ScanFinding } from "../types";

/**
 * One gated browser action the driver took, distilled to the signal the friction
 * detectors need. `action` is the BrowserActionKind-ish label the driver used
 * (e.g. "navigate", "click", "fill") but is kept a free string so the trace is
 * not coupled to the gate's exact enum (a driver may label sub-actions). `ok`
 * is whether that single step succeeded; `ms` is its optional duration.
 */
export interface JourneyStep {
  action: string;
  ok: boolean;
  ms?: number;
}

/**
 * One full attempt at a goal on a route, the pure input to classifyJourney.
 *
 *  - route        the page/path the journey was attempted on (ScanFinding.route
 *                 space, so a journey finding lands beside page findings).
 *  - journey      the named journey/flow (e.g. "billing").
 *  - goal         the human goal the agent tried to complete (e.g. "create an
 *                 invoice"). Used in finding titles/detail.
 *  - steps        the ordered gated actions taken.
 *  - completed    true when the agent reached the goal; false is a dead-end.
 *  - expectedSteps optional baseline step count for the goal (e.g. the happy-path
 *                 count). When absent, DEFAULT_EXPECTED is used for the
 *                 excessive-steps check.
 */
export interface JourneyTrace {
  route: string;
  journey: string;
  goal: string;
  steps: JourneyStep[];
  completed: boolean;
  expectedSteps?: number;
}

/**
 * Baseline expected-step count when a trace omits expectedSteps. Conservative on
 * purpose: a handful of actions (navigate, observe, fill, submit, confirm) is a
 * normal short flow, so 5 is a reasonable neutral baseline that does not flag a
 * typical journey as excessive on its own.
 */
export const DEFAULT_EXPECTED = 5;

/**
 * Excessive-steps multiplier. A completed journey is only flagged when it took
 * MORE than 1.5x the expected step count. The 1.5x slack absorbs normal
 * variation (a corrected typo, an extra observe) so we flag genuine drag, not
 * noise. Precision-first: a journey at or under 1.5x expected is never flagged.
 */
export const EXCESSIVE_STEP_FACTOR = 1.5;

/**
 * Consecutive-repeat threshold for the loop detector. The SAME action appearing
 * 3 or more times in a ROW is a strong signal of a loop / retry / confusion
 * (e.g. click, click, click). Two-in-a-row is common and legitimate (fill one
 * field, fill the next is a different label; but the same label twice can be a
 * correction), so we require 3 to keep this precision-first.
 */
export const REPEAT_LOOP_THRESHOLD = 3;

/** Build the evidence object every journey finding shares, so a reviewer can
 *  verify the friction without re-running the agent. `expected` is the baseline
 *  actually used (provided or default). */
function journeyEvidence(
  trace: JourneyTrace,
): ScanFinding["evidence"] {
  return {
    journey: trace.journey,
    goal: trace.goal,
    steps: trace.steps.length,
    expected: trace.expectedSteps ?? DEFAULT_EXPECTED,
    completed: trace.completed,
  };
}

/**
 * a. DEAD-END: the agent could not complete the goal. This is the strongest
 * friction signal - the journey simply cannot be finished - so it fires
 * ux_gap/HIGH. Precision: unconditional on completed === false; a goal the agent
 * abandoned is by definition a journey a user can get stuck in.
 */
function deadEnd(trace: JourneyTrace): ScanFinding | null {
  if (trace.completed) return null;
  return {
    route: trace.route,
    severity: "high",
    category: "ux_gap",
    title: "Journey could not be completed",
    detail: `The agent could not complete the goal "${trace.goal}" on the "${trace.journey}" journey after ${trace.steps.length} step(s); the flow dead-ends and a user can get stuck here.`,
    evidence: journeyEvidence(trace),
  };
}

/**
 * b. EXCESSIVE STEPS: the goal was reached but it took more than
 * EXCESSIVE_STEP_FACTOR x the expected step count. Too many user actions for the
 * task. Fires ux_gap/MEDIUM. Precision guards: only on a COMPLETED journey (a
 * dead-end is already covered by deadEnd, and step count on an abandoned journey
 * is not a "too many steps to finish" signal), and only strictly ABOVE the
 * threshold so a journey at the slack ceiling is not flagged.
 */
function excessiveSteps(trace: JourneyTrace): ScanFinding | null {
  if (!trace.completed) return null;
  const expected = trace.expectedSteps ?? DEFAULT_EXPECTED;
  const threshold = expected * EXCESSIVE_STEP_FACTOR;
  if (trace.steps.length <= threshold) return null;
  return {
    route: trace.route,
    severity: "medium",
    category: "ux_gap",
    title: `Excessive steps to complete ${trace.goal}`,
    detail: `Completing "${trace.goal}" on the "${trace.journey}" journey took ${trace.steps.length} step(s), more than ${EXCESSIVE_STEP_FACTOR}x the expected ${expected}; the flow has too many user actions.`,
    evidence: journeyEvidence(trace),
  };
}

/**
 * c. MID-JOURNEY FAILED STEP: at least one step failed (ok === false) even
 * though the journey eventually completed. The user hit a wall and retried /
 * recovered - friction worth surfacing. Fires ux_gap/LOW (it self-recovered, so
 * lower than a dead-end). Precision guard: only on a COMPLETED journey, because a
 * failed step on a dead-end is already implied by the high-severity deadEnd
 * finding; we don't double-count the same failure.
 */
function failedStepMidJourney(trace: JourneyTrace): ScanFinding | null {
  if (!trace.completed) return null;
  const failed = trace.steps.filter((s) => s.ok === false).length;
  if (failed === 0) return null;
  return {
    route: trace.route,
    severity: "low",
    category: "ux_gap",
    title: "Friction: a step failed before the journey completed",
    detail: `${failed} step(s) failed before "${trace.goal}" completed on the "${trace.journey}" journey; the user had to recover/retry, indicating confusion or a brittle step.`,
    evidence: { ...journeyEvidence(trace), failedSteps: failed },
  };
}

/**
 * d. LOOP / REPEATED ACTION: the SAME action appears REPEAT_LOOP_THRESHOLD (3)
 * or more times CONSECUTIVELY. A run of identical actions is a loop / repeated
 * retry / confusion signal. Fires ux_gap/LOW. Precision guard: requires a
 * consecutive run (not merely a total count) of >= 3, so an action used a few
 * times across an otherwise varied journey is not flagged; only a genuine
 * back-to-back streak is.
 */
function repeatedActionLoop(trace: JourneyTrace): ScanFinding | null {
  let runAction: string | null = null;
  let runLen = 0;
  let maxRun = 0;
  let loopedAction: string | null = null;
  for (const step of trace.steps) {
    if (step.action === runAction) {
      runLen += 1;
    } else {
      runAction = step.action;
      runLen = 1;
    }
    if (runLen > maxRun) {
      maxRun = runLen;
      loopedAction = runAction;
    }
  }
  if (maxRun < REPEAT_LOOP_THRESHOLD) return null;
  return {
    route: trace.route,
    severity: "low",
    category: "ux_gap",
    title: "Possible loop / repeated action",
    detail: `The action "${loopedAction}" repeated ${maxRun} times in a row on the "${trace.journey}" journey while pursuing "${trace.goal}", suggesting a loop or repeated retries.`,
    evidence: { ...journeyEvidence(trace), repeatedAction: loopedAction, runLength: maxRun },
  };
}

/**
 * Classify one journey trace into zero or more friction findings. A clean,
 * completed, optimal journey with no failed/repeated steps yields []. A single
 * trace can yield MULTIPLE findings (e.g. excessive steps AND a failed step AND
 * a loop). Pure + deterministic: same trace in, same findings out.
 */
export function classifyJourney(trace: JourneyTrace): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const detector of [
    deadEnd,
    excessiveSteps,
    failedStepMidJourney,
    repeatedActionLoop,
  ]) {
    const f = detector(trace);
    if (f) findings.push(f);
  }
  return findings;
}
