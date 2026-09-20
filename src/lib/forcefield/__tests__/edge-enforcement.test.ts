/**
 * Inline edge enforcement is "models advise, policy decides": THIS deterministic
 * function is the policy. The matrix below pins the precedence (worst-first) and
 * the monitor/enforce split. Pure - no db, no crypto.
 */
import { decideEdgeAction, type EdgeSignals } from "@/lib/forcefield/edge-enforcement";

const base: EdgeSignals = { blocked: false, trustBand: "trusted", mandateExceeded: false, principalStatus: "absent", networkHostile: false };
const enforce = { mode: "enforce" as const };
const monitor = { mode: "monitor" as const };

describe("decideEdgeAction - intended action precedence (enforce mode)", () => {
  it.each<[string, Partial<EdgeSignals>, "allow" | "challenge" | "block", string]>([
    ["blocklist beats everything", { blocked: true, trustBand: "trusted" }, "block", "operator_blocklisted"],
    ["mandate violation blocks", { mandateExceeded: true, trustBand: "trusted" }, "block", "mandate_exceeded"],
    ["network hostile blocks", { networkHostile: true, trustBand: "caution" }, "block", "network_hostile"],
    ["hostile band blocks", { trustBand: "hostile" }, "block", "trust_hostile"],
    ["untrusted band challenges", { trustBand: "untrusted" }, "challenge", "trust_untrusted"],
    ["claimed principal challenges", { trustBand: "caution", principalStatus: "claimed" }, "challenge", "principal_unverifiable"],
    ["caution + no red flag allows", { trustBand: "caution" }, "allow", "default_allow"],
    ["verified in-scope allows", { trustBand: "trusted", principalStatus: "verified" }, "allow", "default_allow"],
  ])("%s", (_label, patch, expectedAction, expectedRule) => {
    const d = decideEdgeAction({ ...base, ...patch }, enforce);
    expect(d.intended).toBe(expectedAction);
    expect(d.ruleId).toBe(expectedRule);
    expect(d.action).toBe(expectedAction); // enforce: effective == intended
    expect(d.enforced).toBe(expectedAction !== "allow");
  });

  it("blocklist takes precedence even over a mandate violation", () => {
    expect(decideEdgeAction({ ...base, blocked: true, mandateExceeded: true }, enforce).ruleId).toBe("operator_blocklisted");
  });
});

describe("monitor mode is shadow mode", () => {
  it("records the intended action but never enforces", () => {
    const d = decideEdgeAction({ ...base, trustBand: "hostile" }, monitor);
    expect(d.intended).toBe("block"); // policy still decided block
    expect(d.action).toBe("monitor"); // but the effective action is monitor
    expect(d.enforced).toBe(false); // nothing gated
    expect(d.mode).toBe("monitor");
  });
});

import { qualifiesForAutoBlock } from "@/lib/forcefield/edge-enforcement";

describe("qualifiesForAutoBlock - block the bad agent, NEVER the client", () => {
  const sig = (p: Partial<EdgeSignals>): EdgeSignals => ({ blocked: false, trustBand: "hostile", mandateExceeded: false, principalStatus: "absent", networkHostile: false, ...p });

  it("auto-blocks a PROVEN hostile actor", () => {
    expect(qualifiesForAutoBlock(sig({ trustBand: "hostile" }), { proven: true }).auto).toBe(true);
  });
  it("auto-blocks a verified agent that exceeded its mandate (authorization abused)", () => {
    expect(qualifiesForAutoBlock(sig({ principalStatus: "verified", mandateExceeded: true }), { proven: true }).auto).toBe(true);
  });
  it("NEVER auto-blocks on an inferred grouping (could be legitimate client traffic)", () => {
    const v = qualifiesForAutoBlock(sig({ trustBand: "hostile" }), { proven: false });
    expect(v.auto).toBe(false);
    expect(v.reason).toMatch(/inferred|legitimate/i);
  });
  it("NEVER auto-blocks a verified principal within its mandate (a good, authorized agent)", () => {
    expect(qualifiesForAutoBlock(sig({ principalStatus: "verified", trustBand: "caution" }), { proven: true }).auto).toBe(false);
  });
  it("NEVER auto-blocks a trusted, rule-respecting actor (a good bot)", () => {
    expect(qualifiesForAutoBlock(sig({ trustBand: "trusted" }), { proven: true }).auto).toBe(false);
  });
  it("does not auto-block an untrusted-but-not-hostile actor (watch, let a human decide)", () => {
    expect(qualifiesForAutoBlock(sig({ trustBand: "untrusted" }), { proven: true }).auto).toBe(false);
  });
});
