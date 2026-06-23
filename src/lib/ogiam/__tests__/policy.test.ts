/**
 * OGIAM policy tests. The whole pitch is determinism, so these pin the exact
 * outcome, rule, and tier for representative actions, and prove the function is
 * pure (same inputs always yield the same decision).
 */

import { decide, riskTierFor, POLICY_VERSION } from "@/lib/ogiam/policy";
import type { OgiamAction } from "@/lib/ogiam/types";

function action(over: Partial<OgiamAction> = {}): OgiamAction {
  return {
    tool: "get_calendar",
    capability: "*",
    isMutation: false,
    surface: "/assistant",
    paramsHash: "h",
    signals: {},
    ...over,
  };
}

describe("riskTierFor", () => {
  it("read-only is low", () => {
    expect(riskTierFor(action())).toBe("low");
  });
  it("a plain mutation is medium", () => {
    expect(riskTierFor(action({ isMutation: true, tool: "create_note" }))).toBe(
      "medium",
    );
  });
  it("a money or send or admin mutation is high", () => {
    expect(
      riskTierFor(action({ isMutation: true, tool: "send_invoice", capability: "finance.write" })),
    ).toBe("high");
    expect(
      riskTierFor(action({ isMutation: true, tool: "mail_send", capability: "mail.send" })),
    ).toBe("high");
  });
  it("a detected secret is critical regardless of tool", () => {
    expect(
      riskTierFor(action({ isMutation: false, signals: { secretDetected: true } })),
    ).toBe("critical");
  });
});

describe("decide: rules and outcomes", () => {
  it("R-DEFAULT-ALLOW for a read-only action", () => {
    const d = decide(action(), { mode: "enforce" });
    expect(d.ruleId).toBe("R-DEFAULT-ALLOW");
    expect(d.intendedOutcome).toBe("allow");
    expect(d.wouldBlock).toBe(false);
    expect(d.policyVersion).toBe(POLICY_VERSION);
  });

  it("R-SECRET-DENY when a secret is in the parameters", () => {
    const d = decide(action({ signals: { secretDetected: true } }), { mode: "enforce" });
    expect(d.ruleId).toBe("R-SECRET-DENY");
    expect(d.intendedOutcome).toBe("deny");
    expect(d.riskTier).toBe("critical");
    expect(d.wouldBlock).toBe(true);
  });

  it("R-INJECTION-ESCALATE for a high injection score on a mutation", () => {
    const d = decide(
      action({ isMutation: true, tool: "create_note", signals: { injectionScore: 0.95 } }),
      { mode: "enforce" },
    );
    expect(d.ruleId).toBe("R-INJECTION-ESCALATE");
    expect(d.intendedOutcome).toBe("escalate");
  });

  it("R-PII-OUTBOUND-TRANSFORM for PII heading into a send", () => {
    const d = decide(
      action({ isMutation: true, tool: "mail_send", capability: "mail.send", signals: { piiDetected: true } }),
      { mode: "enforce" },
    );
    expect(d.ruleId).toBe("R-PII-OUTBOUND-TRANSFORM");
    expect(d.intendedOutcome).toBe("transform");
  });

  it("R-HIGHRISK-MUTATION-ESCALATE for a high-risk mutation", () => {
    const d = decide(
      action({ isMutation: true, tool: "delete_client", capability: "clients.write" }),
      { mode: "enforce" },
    );
    expect(d.ruleId).toBe("R-HIGHRISK-MUTATION-ESCALATE");
    expect(d.intendedOutcome).toBe("escalate");
  });

  it("R-MUTATION-ESCALATE for an ordinary mutation", () => {
    const d = decide(action({ isMutation: true, tool: "create_note" }), { mode: "enforce" });
    expect(d.ruleId).toBe("R-MUTATION-ESCALATE");
    expect(d.intendedOutcome).toBe("escalate");
  });
});

describe("decide: enforcement mode", () => {
  it("monitor mode never enforces and never blocks, but records the intent", () => {
    const d = decide(action({ signals: { secretDetected: true } }), { mode: "monitor" });
    expect(d.intendedOutcome).toBe("deny"); // policy still decided deny
    expect(d.effectiveOutcome).toBe("monitor"); // but it does not act
    expect(d.enforced).toBe(false);
    expect(d.wouldBlock).toBe(true); // and we record that it WOULD have blocked
  });

  it("enforce mode acts on the intended outcome", () => {
    const d = decide(action({ signals: { secretDetected: true } }), { mode: "enforce" });
    expect(d.effectiveOutcome).toBe("deny");
    expect(d.enforced).toBe(true);
  });
});

describe("decide: determinism", () => {
  it("identical inputs yield byte-identical decisions", () => {
    const a = action({ isMutation: true, tool: "send_invoice", capability: "finance.write", signals: { piiDetected: true } });
    const d1 = decide(a, { mode: "monitor" });
    const d2 = decide(a, { mode: "monitor" });
    expect(JSON.stringify(d1)).toBe(JSON.stringify(d2));
  });
});
