/**
 * DETERMINISTIC scripted-journey runner: the cheap, gate-native core of the
 * tier-2 journey-friction tier.
 *
 * WHAT THIS IS (and is NOT)
 * -------------------------
 * The agentic exploration driver (openclaw - an LLM choosing each next browser
 * action) is a SEPARATE, later build. THIS runner needs no LLM and no agent: it
 * executes an OPERATOR-DEFINED, fixed sequence of browser steps (a ScriptedJourney
 * like "reach pricing" or "complete signup"), records a JourneyTrace, and hands
 * that trace to the existing pure classifyJourney (./journey.ts). Same trace
 * shape, same classifier, same recordScan ingest path - so the high-value
 * journey-friction findings (dead-end, excessive-steps, loop, mid-journey
 * failure) are delivered DETERMINISTICALLY, model-agnostic and gate-native.
 *
 * THE SAFETY MODEL: EVERY STEP IS GATE-AUTHORIZED FIRST
 * ----------------------------------------------------
 * This runner obeys the IDENTICAL contract the future agentic driver will (see
 * ./gate.ts authorizeBrowserAction): before any browser step is executed, the
 * runner PROPOSES the corresponding BrowserAction to the gate (deps.authorize)
 * and only acts on an `allowed` verdict. Read-only steps (navigate / observe /
 * hover / key) pass the gate freely (read-only floor). A mutating step (click /
 * fill / submit, or mutating === true) is DENIED by the gate unless an active
 * ui_probe scope authorizes it. Because every step is authorized before it runs,
 * the runner can NEVER act outside a recorded gate decision - the gate decides,
 * the runner only executes an allowed step. A gate block is a real dead-end: the
 * journey cannot proceed, so the loop STOPS and the trace records the deny reason.
 *
 * PURITY
 * ------
 * This module imports NO Playwright and NO fetch. Everything external is injected
 * via RunScriptedJourneyDeps (authorize, executeStep, now), so the orchestration
 * is fully unit-testable with hand-rolled deps - exactly like ./gate.ts and
 * ./capture.ts. The live CLI (scripts/journey-scan.mjs) supplies the two concrete
 * deps (a real gate-authorize HTTP call and a real Playwright page) at the edge.
 *
 * NO DATA LOST: the produced JourneyTrace[] is POSTed to
 * /api/admin/platform-scans/ingest under traces[], which runs classifyJourney
 * server-side and flows the findings through the SAME recordScan pipeline as every
 * other scan source.
 */

import type { BrowserAction, BrowserActionKind } from "./gate";
import type { JourneyStep, JourneyTrace } from "./journey";

/**
 * One operator-authored step in a scripted journey. `kind` is either a real
 * BrowserActionKind (navigate / observe / hover / key / click / fill / submit) -
 * which is gate-authorized then executed - or the sentinel "expect", an assertion
 * step that is executed (the assertion check) but never gate-authorized (it does
 * not touch the client; it only reads runner-side state such as URL/visibility).
 *
 *  - selector     the DOM selector the action / assertion targets, when applicable.
 *  - value        the value to fill (for "fill") or a comparison value (for an
 *                 "expect" url/text match); interpretation lives in executeStep.
 *  - targetUrl    overrides the journey route for this step's BrowserAction
 *                 (e.g. a navigate to a sub-route). Defaults to journey.route.
 *  - mutating     force the mutating tier even for a read-only kind (mirrors the
 *                 gate's mutating override; can only UP-classify).
 *  - description  human label, used in the recorded action string for "expect"
 *                 steps ("expect:<description>") so a reviewer can read the trace.
 */
export interface ScriptedStep {
  kind: BrowserActionKind | "expect";
  selector?: string;
  value?: string;
  targetUrl?: string;
  mutating?: boolean;
  description?: string;
}

/**
 * An operator-defined journey: a fixed, ordered sequence of steps attempting one
 * goal on one route. Mirrors the JourneyTrace metadata so the produced trace is a
 * near-identity projection (route / journey / goal / expectedSteps carry through).
 */
export interface ScriptedJourney {
  platform: string;
  route: string;
  journey: string;
  goal: string;
  expectedSteps?: number;
  steps: ScriptedStep[];
}

/**
 * Injected collaborators. Nothing here is imported by the module itself - the live
 * CLI wires the concrete gate call + Playwright page; tests wire pure mocks.
 *
 *  - authorize    PROPOSE a BrowserAction to the gate; returns the verdict. The
 *                 runner only executes a step the gate allowed.
 *  - executeStep  perform a step. For a browser step: do the navigate/click/fill/
 *                 etc. and return whether it succeeded. For an "expect" step: run
 *                 the assertion and return whether it passed. MUST NOT throw for a
 *                 normal failure (return false); a thrown error is treated as an
 *                 abort (the step is ok:false and the journey did not complete).
 *  - now          injectable clock for deterministic per-step ms in tests.
 */
export interface RunScriptedJourneyDeps {
  authorize: (
    action: BrowserAction,
  ) => Promise<{ allowed: boolean; reason?: string }>;
  executeStep: (step: ScriptedStep) => Promise<boolean>;
  now?: () => number;
}

/** Build the BrowserAction proposed to the gate for a browser (non-expect) step.
 *  targetUrl falls back to the journey route; platform/selector/mutating carry
 *  through. This is the exact shape authorizeBrowserAction (and the future
 *  agentic driver) consumes. */
function toBrowserAction(
  journey: ScriptedJourney,
  step: ScriptedStep,
): BrowserAction {
  return {
    kind: step.kind as BrowserActionKind,
    targetUrl: step.targetUrl ?? journey.route,
    platform: journey.platform,
    selector: step.selector,
    mutating: step.mutating,
  };
}

/**
 * Run one scripted journey through the gate, producing a JourneyTrace ready for
 * classifyJourney / the ingest traces[] path.
 *
 * Per step, in order:
 *   - "expect" step: NOT gate-authorized (it touches no client). Run
 *     deps.executeStep (the assertion). Record a JourneyStep
 *     { action: "expect:<description>", ok, ms }. A FAILED expect means the goal
 *     was not reached (completed becomes false) but the loop continues (later
 *     steps/assertions are still recorded for the trace).
 *   - browser step: build the BrowserAction and call deps.authorize FIRST.
 *       * NOT allowed -> record { action: "<kind>[gate:<reason>]", ok: false },
 *         then STOP. A gate block is a genuine dead-end (the journey cannot
 *         proceed without acting outside a gate decision, which is forbidden), so
 *         completed is false.
 *       * allowed -> run deps.executeStep, record { action: "<kind>", ok, ms } and
 *         CONTINUE. A failed execute is ok:false but does not stop the loop (the
 *         step list defines the flow; classifyJourney surfaces the mid-journey
 *         failure / loop signals from the recorded steps).
 *   - a thrown error from authorize or executeStep aborts the journey: the step is
 *     recorded ok:false and the loop STOPS with completed:false (an unexpected
 *     failure is not a completed goal).
 *
 * completed = no gate block occurred AND every "expect" passed AND no step threw.
 */
export async function runScriptedJourney(
  journey: ScriptedJourney,
  deps: RunScriptedJourneyDeps,
): Promise<JourneyTrace> {
  const now = deps.now ?? Date.now;
  const steps: JourneyStep[] = [];
  let completed = true;

  for (const step of journey.steps) {
    // --- assertion ("expect") step: executed, never gate-authorized -----------
    if (step.kind === "expect") {
      const label = `expect:${step.description ?? step.selector ?? "assertion"}`;
      const started = now();
      let ok = false;
      try {
        ok = await deps.executeStep(step);
      } catch {
        // A thrown assertion is a hard failure: record it, mark incomplete, stop.
        steps.push({ action: label, ok: false, ms: now() - started });
        completed = false;
        break;
      }
      steps.push({ action: label, ok, ms: now() - started });
      if (!ok) completed = false; // failed expectation: goal not reached.
      continue;
    }

    // --- browser step: gate-authorize FIRST, then execute on allow ------------
    const action = toBrowserAction(journey, step);
    let verdict: { allowed: boolean; reason?: string };
    try {
      verdict = await deps.authorize(action);
    } catch {
      // The gate query itself failed: cannot prove the step is authorized, so we
      // must NOT execute it. Record a block-shaped step and stop, fail closed.
      steps.push({ action: `${step.kind}[gate:authorize_error]`, ok: false });
      completed = false;
      break;
    }

    if (!verdict.allowed) {
      // Gate dead-end: the journey cannot proceed without acting outside a gate
      // decision (forbidden). Carry the deny reason in the action string and STOP.
      const reason = verdict.reason ?? "denied";
      steps.push({ action: `${step.kind}[gate:${reason}]`, ok: false });
      completed = false;
      break;
    }

    // Allowed: execute the step and record its outcome; continue the flow.
    const started = now();
    let ok = false;
    try {
      ok = await deps.executeStep(step);
    } catch {
      // An execute that throws is an abort, not a recoverable mid-journey failure.
      steps.push({ action: step.kind, ok: false, ms: now() - started });
      completed = false;
      break;
    }
    steps.push({ action: step.kind, ok, ms: now() - started });
    // A failed execute (ok:false) is recorded but does NOT stop the loop, mirroring
    // a user who hit a wall and pressed on; classifyJourney surfaces the friction.
  }

  return {
    route: journey.route,
    journey: journey.journey,
    goal: journey.goal,
    steps,
    completed,
    expectedSteps: journey.expectedSteps,
  };
}
