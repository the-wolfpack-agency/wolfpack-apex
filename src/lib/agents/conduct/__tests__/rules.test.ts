/**
 * Conduct rule C-NO-SELF-TAMPER - deterministic, no DB. An agent is refused a
 * governance-control capability even if it holds it; a benign agent capability
 * passes; the human assistant is never subject to this rule.
 */
import { evaluateConduct, GOVERNANCE_CONTROL_CAPABILITIES } from "../rules";

it("denies an agent invoking a governance-control capability", () => {
  for (const cap of GOVERNANCE_CONTROL_CAPABILITIES) {
    const v = evaluateConduct({ capability: cap, isAgent: true });
    expect(v.outcome).toBe("deny");
    expect(v.ruleId).toBe("C-NO-SELF-TAMPER");
  }
});

it("allows an agent invoking a benign, non-governance capability", () => {
  expect(evaluateConduct({ capability: "calendar.read", isAgent: true }).outcome).toBe("allow");
  expect(evaluateConduct({ capability: "mail.send", isAgent: true }).outcome).toBe("allow");
});

it("never applies to the human assistant (isAgent false)", () => {
  expect(evaluateConduct({ capability: "settings.manage_team", isAgent: false }).outcome).toBe("allow");
});
