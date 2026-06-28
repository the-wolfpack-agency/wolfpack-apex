/**
 * Tests for the DETERMINISTIC scripted-journey runner (runScriptedJourney).
 *
 * Pure orchestration: authorize + executeStep + now are all injected, so there is
 * NO real browser, NO real gate, and NO network here. The tests prove:
 *  - all steps allowed + executed + expects passing -> completed:true, right count
 *  - a gate-DENIED mutating step -> ok:false with the reason encoded, loop STOPS,
 *    completed:false, and the gate saw the right BrowserAction (kind/mutating)
 *  - a step whose executeStep returns false -> ok:false recorded (loop continues)
 *  - a failing "expect" -> completed:false
 *  - end-to-end: the produced trace -> the REAL classifyJourney -> expected finding
 *  - read-only steps authorize without a scope (allowed:true) -> proceed
 */
import {
  runScriptedJourney,
  type ScriptedJourney,
  type ScriptedStep,
  type RunScriptedJourneyDeps,
} from "../journey-runner";
import { classifyJourney } from "../journey";
import type { BrowserAction } from "../gate";

/** A deterministic clock that ticks +10ms each read, so every step gets ms. */
function tickingClock(start = 1000, step = 10): () => number {
  let t = start - step;
  return () => {
    t += step;
    return t;
  };
}

/** Build deps with a recording authorize and a programmable executeStep. */
function makeDeps(opts: {
  authorize?: (a: BrowserAction) => Promise<{ allowed: boolean; reason?: string }>;
  executeStep?: (s: ScriptedStep) => Promise<boolean>;
}): {
  deps: RunScriptedJourneyDeps;
  authorizeCalls: BrowserAction[];
  executeCalls: ScriptedStep[];
} {
  const authorizeCalls: BrowserAction[] = [];
  const executeCalls: ScriptedStep[] = [];
  // A single recording wrapper around the supplied (or default) impl, so calls
  // are counted exactly once.
  const innerAuth =
    opts.authorize ?? (async () => ({ allowed: true }));
  const innerExec = opts.executeStep ?? (async () => true);
  const deps: RunScriptedJourneyDeps = {
    authorize: async (a) => {
      authorizeCalls.push(a);
      return innerAuth(a);
    },
    executeStep: async (s) => {
      executeCalls.push(s);
      return innerExec(s);
    },
    now: tickingClock(),
  };
  return { deps, authorizeCalls, executeCalls };
}

function journey(steps: ScriptedStep[], over: Partial<ScriptedJourney> = {}): ScriptedJourney {
  return {
    platform: "acme",
    route: "/signup",
    journey: "signup",
    goal: "complete signup",
    steps,
    ...over,
  };
}

describe("runScriptedJourney", () => {
  it("all steps allowed + executed + expect passing -> completed:true", async () => {
    const { deps, authorizeCalls, executeCalls } = makeDeps({});
    const trace = await runScriptedJourney(
      journey([
        { kind: "navigate", targetUrl: "/signup" },
        { kind: "fill", selector: "#email", value: "a@b.com", mutating: true },
        { kind: "submit", selector: "form", mutating: true },
        { kind: "expect", description: "welcome visible", selector: ".welcome" },
      ]),
      deps,
    );

    expect(trace.completed).toBe(true);
    expect(trace.steps).toHaveLength(4);
    expect(trace.steps.every((s) => s.ok)).toBe(true);
    // expect step is NOT gate-authorized; the three browser steps are.
    expect(authorizeCalls).toHaveLength(3);
    expect(executeCalls).toHaveLength(4);
    expect(trace.steps[3].action).toBe("expect:welcome visible");
    // every recorded browser step carries a ms from the injected clock.
    expect(trace.steps[0].ms).toBeGreaterThan(0);
    // trace metadata projects from the journey.
    expect(trace.route).toBe("/signup");
    expect(trace.goal).toBe("complete signup");
  });

  it("read-only steps authorize without a scope (allowed:true) and proceed", async () => {
    const seen: BrowserAction[] = [];
    const { deps } = makeDeps({
      authorize: async (a) => {
        seen.push(a);
        // Mirror the gate: read-only kinds are allowed with no scope.
        return { allowed: true };
      },
    });
    const trace = await runScriptedJourney(
      journey([
        { kind: "navigate" },
        { kind: "observe", selector: "main" },
      ]),
      deps,
    );
    expect(trace.completed).toBe(true);
    expect(trace.steps.map((s) => s.action)).toEqual(["navigate", "observe"]);
    expect(seen.every((a) => a.mutating === undefined)).toBe(true);
  });

  it("a gate-DENIED mutating step -> ok:false w/ reason, loop STOPS, completed:false", async () => {
    const { deps, authorizeCalls, executeCalls } = makeDeps({
      authorize: async (a) =>
        a.kind === "click"
          ? { allowed: false, reason: "no_active_scope" }
          : { allowed: true },
    });
    const trace = await runScriptedJourney(
      journey([
        { kind: "navigate" },
        { kind: "click", selector: "#buy", mutating: true },
        // never reached: the loop stops at the gate block.
        { kind: "expect", description: "should not run" },
      ]),
      deps,
    );

    expect(trace.completed).toBe(false);
    expect(trace.steps).toHaveLength(2); // navigate + blocked click; no expect.
    const blocked = trace.steps[1];
    expect(blocked.ok).toBe(false);
    expect(blocked.action).toBe("click[gate:no_active_scope]");

    // The gate saw the right BrowserAction for the denied click.
    const clickAction = authorizeCalls.find((a) => a.kind === "click");
    expect(clickAction).toBeDefined();
    expect(clickAction!.kind).toBe("click");
    expect(clickAction!.mutating).toBe(true);
    expect(clickAction!.selector).toBe("#buy");
    expect(clickAction!.platform).toBe("acme");

    // The denied click was NEVER executed (gate decides before execute).
    expect(executeCalls.some((s) => s.kind === "click")).toBe(false);
  });

  it("a step whose executeStep returns false -> ok:false recorded, loop continues", async () => {
    const { deps } = makeDeps({
      executeStep: async (s) => s.kind !== "fill", // fill fails, others ok
    });
    const trace = await runScriptedJourney(
      journey([
        { kind: "navigate" },
        { kind: "fill", selector: "#x", value: "v", mutating: true },
        { kind: "submit", mutating: true },
      ]),
      deps,
    );
    // Loop did NOT stop on the failed execute (only a gate block / throw stops it).
    expect(trace.steps).toHaveLength(3);
    expect(trace.steps[1].action).toBe("fill");
    expect(trace.steps[1].ok).toBe(false);
    expect(trace.steps[2].ok).toBe(true);
    // A mid-journey failed step is friction but the journey still "completed"
    // (no gate block, no failed expect, no throw).
    expect(trace.completed).toBe(true);
  });

  it("a failing expect -> completed:false", async () => {
    const { deps } = makeDeps({
      executeStep: async (s) => s.kind !== "expect", // the assertion fails
    });
    const trace = await runScriptedJourney(
      journey([
        { kind: "navigate" },
        { kind: "expect", description: "pricing visible" },
      ]),
      deps,
    );
    expect(trace.completed).toBe(false);
    expect(trace.steps[1].action).toBe("expect:pricing visible");
    expect(trace.steps[1].ok).toBe(false);
    expect(trace.steps).toHaveLength(2); // a failed expect continues the loop.
  });

  it("a thrown executeStep aborts the journey: ok:false, loop stops, completed:false", async () => {
    const { deps } = makeDeps({
      executeStep: async (s) => {
        if (s.kind === "submit") throw new Error("boom");
        return true;
      },
    });
    const trace = await runScriptedJourney(
      journey([
        { kind: "navigate" },
        { kind: "submit", mutating: true },
        { kind: "expect", description: "unreached" },
      ]),
      deps,
    );
    expect(trace.completed).toBe(false);
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[1].action).toBe("submit");
    expect(trace.steps[1].ok).toBe(false);
  });

  it("an authorize that throws fails closed: blocked-shaped step, loop stops", async () => {
    const { deps, executeCalls } = makeDeps({
      authorize: async () => {
        throw new Error("gate unreachable");
      },
    });
    const trace = await runScriptedJourney(
      journey([{ kind: "click", mutating: true }]),
      deps,
    );
    expect(trace.completed).toBe(false);
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0].action).toBe("click[gate:authorize_error]");
    expect(trace.steps[0].ok).toBe(false);
    // Fail closed: the step was never executed.
    expect(executeCalls).toHaveLength(0);
  });

  describe("runner -> REAL classifyJourney (the end-to-end contract)", () => {
    it("a gate dead-end trace classifies as a HIGH ux_gap dead-end finding", async () => {
      const { deps } = makeDeps({
        authorize: async (a) =>
          a.kind === "click"
            ? { allowed: false, reason: "no_active_scope" }
            : { allowed: true },
      });
      const trace = await runScriptedJourney(
        journey([
          { kind: "navigate" },
          { kind: "click", selector: "#checkout", mutating: true },
        ]),
        deps,
      );

      const findings = classifyJourney(trace);
      const deadEnd = findings.find((f) => f.title === "Journey could not be completed");
      expect(deadEnd).toBeDefined();
      expect(deadEnd!.severity).toBe("high");
      expect(deadEnd!.category).toBe("ux_gap");
      expect(deadEnd!.route).toBe("/signup");
    });

    it("a clean completed trace classifies to NO findings", async () => {
      const { deps } = makeDeps({});
      const trace = await runScriptedJourney(
        journey([
          { kind: "navigate" },
          { kind: "fill", selector: "#email", value: "a@b.com", mutating: true },
          { kind: "submit", mutating: true },
          { kind: "expect", description: "done" },
        ]),
        deps,
      );
      expect(trace.completed).toBe(true);
      expect(classifyJourney(trace)).toEqual([]);
    });

    it("a completed trace with a failed mid-step classifies as LOW friction", async () => {
      const { deps } = makeDeps({
        executeStep: async (s) => !(s.kind === "fill"),
      });
      const trace = await runScriptedJourney(
        journey([
          { kind: "navigate" },
          { kind: "fill", selector: "#x", value: "v", mutating: true },
          { kind: "submit", mutating: true },
          { kind: "expect", description: "done" },
        ]),
        deps,
      );
      const findings = classifyJourney(trace);
      const friction = findings.find(
        (f) => f.title === "Friction: a step failed before the journey completed",
      );
      expect(friction).toBeDefined();
      expect(friction!.severity).toBe("low");
    });
  });
});
