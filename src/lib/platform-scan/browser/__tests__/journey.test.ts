/**
 * Unit tests for the tier-2 journey-friction classifier (browser/journey.ts).
 *
 * classifyJourney is a PURE function, so every friction rule is testable without
 * a browser, the gate, or the network. We assert each detector in isolation
 * (dead-end, excessive steps, mid-journey failed step, loop) plus a combination
 * that yields multiple findings, plus the clean (optimal) case that yields none.
 */
import {
  classifyJourney,
  DEFAULT_EXPECTED,
  EXCESSIVE_STEP_FACTOR,
  REPEAT_LOOP_THRESHOLD,
  type JourneyTrace,
  type JourneyStep,
} from "@/lib/platform-scan/browser/journey";

function step(action: string, ok = true, ms?: number): JourneyStep {
  return ms === undefined ? { action, ok } : { action, ok, ms };
}

/** Build a varied (no consecutive repeats) run of N ok steps. */
function okSteps(n: number): JourneyStep[] {
  return Array.from({ length: n }, (_, i) => step(`act_${i % 4}_${i}`, true));
}

const BASE: JourneyTrace = {
  route: "/billing",
  journey: "billing",
  goal: "create an invoice",
  steps: okSteps(4),
  completed: true,
};

it("a completed, optimal journey yields no findings", () => {
  expect(classifyJourney(BASE)).toEqual([]);
});

it("a journey at exactly the excessive-step threshold is not flagged (precision)", () => {
  // expected default 5 * 1.5 = 7.5; 7 steps is at/under the threshold -> clean.
  const trace = { ...BASE, steps: okSteps(7) };
  expect(EXCESSIVE_STEP_FACTOR).toBe(1.5);
  expect(DEFAULT_EXPECTED).toBe(5);
  expect(classifyJourney(trace)).toEqual([]);
});

it("not completed -> high-severity dead-end finding", () => {
  const trace = { ...BASE, completed: false, steps: okSteps(3) };
  const findings = classifyJourney(trace);
  expect(findings).toEqual([
    expect.objectContaining({
      route: "/billing",
      category: "ux_gap",
      severity: "high",
      title: "Journey could not be completed",
      evidence: expect.objectContaining({
        journey: "billing",
        goal: "create an invoice",
        steps: 3,
        completed: false,
      }),
    }),
  ]);
});

it("excessive steps on a completed journey -> medium finding", () => {
  // 8 > 5 * 1.5 (7.5) -> flagged.
  const trace = { ...BASE, steps: okSteps(8) };
  const findings = classifyJourney(trace);
  expect(findings).toEqual([
    expect.objectContaining({
      category: "ux_gap",
      severity: "medium",
      title: "Excessive steps to complete create an invoice",
      evidence: expect.objectContaining({ steps: 8, expected: DEFAULT_EXPECTED, completed: true }),
    }),
  ]);
});

it("excessive steps honors a provided expectedSteps baseline", () => {
  // expectedSteps 2 * 1.5 = 3; 4 steps -> flagged.
  const trace = { ...BASE, expectedSteps: 2, steps: okSteps(4) };
  const findings = classifyJourney(trace);
  expect(findings.map((f) => f.title)).toContain("Excessive steps to complete create an invoice");
  expect(findings[0].evidence).toEqual(expect.objectContaining({ expected: 2 }));
});

it("a failed step before completion -> low-severity friction finding", () => {
  const trace: JourneyTrace = {
    ...BASE,
    steps: [step("navigate"), step("fill", false), step("fill", true), step("submit")],
  };
  const findings = classifyJourney(trace);
  expect(findings).toEqual([
    expect.objectContaining({
      category: "ux_gap",
      severity: "low",
      title: "Friction: a step failed before the journey completed",
      evidence: expect.objectContaining({ failedSteps: 1 }),
    }),
  ]);
});

it("a failed step on a NOT-completed journey is not double-counted (only the dead-end fires)", () => {
  const trace: JourneyTrace = {
    ...BASE,
    completed: false,
    steps: [step("navigate"), step("submit", false)],
  };
  const findings = classifyJourney(trace);
  expect(findings.map((f) => f.title)).toEqual(["Journey could not be completed"]);
});

it("a consecutive repeated action (>=3) -> low-severity loop finding", () => {
  const trace: JourneyTrace = {
    ...BASE,
    steps: [step("navigate"), step("click"), step("click"), step("click"), step("submit")],
  };
  const findings = classifyJourney(trace);
  expect(REPEAT_LOOP_THRESHOLD).toBe(3);
  expect(findings).toEqual([
    expect.objectContaining({
      category: "ux_gap",
      severity: "low",
      title: "Possible loop / repeated action",
      evidence: expect.objectContaining({ repeatedAction: "click", runLength: 3 }),
    }),
  ]);
});

it("the same action twice in a row is NOT a loop (precision: needs >=3 consecutive)", () => {
  const trace: JourneyTrace = {
    ...BASE,
    steps: [step("click"), step("click"), step("submit")],
  };
  expect(classifyJourney(trace)).toEqual([]);
});

it("non-consecutive repeats of an action are NOT a loop", () => {
  const trace: JourneyTrace = {
    ...BASE,
    steps: [step("click"), step("observe"), step("click"), step("observe"), step("click")],
  };
  expect(classifyJourney(trace)).toEqual([]);
});

it("a combination yields multiple findings (excessive + failed + loop)", () => {
  const trace: JourneyTrace = {
    ...BASE,
    expectedSteps: 3,
    completed: true,
    steps: [
      step("navigate"),
      step("click", false),
      step("click", true),
      step("click", true), // 3-in-a-row loop
      step("fill"),
      step("fill"),
      step("submit"),
    ], // 7 steps > 3 * 1.5 (4.5) -> excessive
  };
  const titles = classifyJourney(trace).map((f) => f.title);
  expect(titles).toEqual([
    "Excessive steps to complete create an invoice",
    "Friction: a step failed before the journey completed",
    "Possible loop / repeated action",
  ]);
});

it("a dead-end skips the completed-gated detectors (excessive/failed-step) but a loop still fires", () => {
  // deadEnd + repeatedActionLoop fire (loop is not completed-gated); excessiveSteps
  // and failedStepMidJourney are completed-gated and skip on a dead-end.
  const trace: JourneyTrace = {
    ...BASE,
    completed: false,
    steps: [step("click", false), step("click"), step("click"), step("click"), step("click")],
  };
  const titles = classifyJourney(trace).map((f) => f.title);
  expect(titles).toEqual(["Journey could not be completed", "Possible loop / repeated action"]);
});

it("is deterministic: same trace in, same findings out", () => {
  const trace = { ...BASE, steps: okSteps(9) };
  expect(classifyJourney(trace)).toEqual(classifyJourney(trace));
});
