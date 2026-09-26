/**
 * Prove-it-fails tests for the deterministic engineering invariants added to the
 * OGIAM policy registry. The discipline: each rule must FIRE on the exact bad
 * input (the thing it exists to stop) and must NOT fire on the clean variant.
 * A rule without both halves is a rule you cannot trust.
 *
 * These are decidable facts (a deploy count, a CI status, a dependency delta),
 * so the gate decides them outright - no model, no judgment.
 */
import { decide, POLICY_RULES } from "@/lib/ogiam/policy";
import type { OgiamAction } from "@/lib/ogiam/types";

function action(over: Partial<OgiamAction> = {}): OgiamAction {
  return { tool: "apply_change", capability: "code.write", isMutation: true, surface: "/factory", paramsHash: "h", signals: {}, ...over };
}
const enforce = { mode: "enforce" as const };

describe("R-DEPLOY-ONCE-DENY", () => {
  it("DENIES a change that would deploy more than once", () => {
    const d = decide(action({ signals: { deploymentCount: 2 } }), enforce);
    expect(d.ruleId).toBe("R-DEPLOY-ONCE-DENY");
    expect(d.intendedOutcome).toBe("deny");
    expect(d.wouldBlock).toBe(true);
  });
  it("does NOT fire for a single deployment", () => {
    expect(decide(action({ signals: { deploymentCount: 1 } }), enforce).ruleId).not.toBe("R-DEPLOY-ONCE-DENY");
  });
  it("is inert when the action carries no deployment count (existing actions unaffected)", () => {
    expect(decide(action({ signals: {} }), enforce).ruleId).not.toBe("R-DEPLOY-ONCE-DENY");
  });
});

describe("R-CI-INCOMPLETE-DENY", () => {
  it("DENIES a mutation whose CI has not fully passed", () => {
    const d = decide(action({ signals: { ciComplete: false } }), enforce);
    expect(d.ruleId).toBe("R-CI-INCOMPLETE-DENY");
    expect(d.intendedOutcome).toBe("deny");
  });
  it("does NOT fire once CI is green", () => {
    expect(decide(action({ signals: { ciComplete: true } }), enforce).ruleId).not.toBe("R-CI-INCOMPLETE-DENY");
  });
  it("is inert when CI status is not applicable (undefined)", () => {
    expect(decide(action({ signals: {} }), enforce).ruleId).not.toBe("R-CI-INCOMPLETE-DENY");
  });
});

describe("R-DEPENDENCY-ADDED-ESCALATE", () => {
  it("ESCALATES to a human when the change adds a runtime dependency", () => {
    const d = decide(action({ signals: { dependencyDelta: 1 } }), enforce);
    expect(d.ruleId).toBe("R-DEPENDENCY-ADDED-ESCALATE");
    expect(d.intendedOutcome).toBe("escalate");
    expect(d.wouldBlock).toBe(true);
  });
  it("does NOT fire when no dependency was added (delta 0)", () => {
    expect(decide(action({ signals: { dependencyDelta: 0 } }), enforce).ruleId).not.toBe("R-DEPENDENCY-ADDED-ESCALATE");
  });
  it("does NOT fire when a dependency was REMOVED (negative delta)", () => {
    expect(decide(action({ signals: { dependencyDelta: -1 } }), enforce).ruleId).not.toBe("R-DEPENDENCY-ADDED-ESCALATE");
  });
});

describe("precedence", () => {
  it("a secret still denies even when a deploy-count violation is also present (secret is first)", () => {
    const d = decide(action({ signals: { secretDetected: true, deploymentCount: 5 } }), enforce);
    expect(d.ruleId).toBe("R-SECRET-DENY");
  });
  it("deploy-once (deny) takes precedence over dependency-added (escalate)", () => {
    const d = decide(action({ signals: { deploymentCount: 3, dependencyDelta: 2 } }), enforce);
    expect(d.ruleId).toBe("R-DEPLOY-ONCE-DENY");
  });
});

describe("registry integrity", () => {
  it("every rule has a unique id and a rationale", () => {
    const ids = POLICY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(POLICY_RULES.every((r) => r.rationale.length > 0)).toBe(true);
  });
  it("the terminal rule always matches (fail-closed default can never be reached in normal flow)", () => {
    const terminal = POLICY_RULES[POLICY_RULES.length - 1];
    expect(terminal.id).toBe("R-DEFAULT-ALLOW");
    expect(terminal.test(action({ isMutation: false, signals: {} }), "low")).not.toBeNull();
  });
});
