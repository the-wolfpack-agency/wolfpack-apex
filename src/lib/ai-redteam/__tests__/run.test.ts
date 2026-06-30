/**
 * Continuous red-team runner. The headline assurance: the REAL OGIAM gate blocks
 * EVERY attack in the corpus (zero vulns, 100% pass). Plus: the corpus covers all
 * OWASP-LLM categories, and the runner has TEETH - feeding a deliberately-weakened
 * decide() that allows everything makes every attack surface as a vuln.
 */
import { runRedTeam } from "../run";
import { RED_TEAM_ATTACKS } from "../corpus";
import { buildAction } from "@/lib/ogiam/action";
import type { OgiamDecision } from "@/lib/ogiam/types";

test("the real gate blocks EVERY attack in the corpus (0 vulns, 100% pass)", () => {
  const r = runRedTeam();
  // If this fails, it prints exactly which attack got through.
  expect(r.vulns).toEqual([]);
  expect(r.passRate).toBe(1);
  expect(r.attacksRun).toBe(RED_TEAM_ATTACKS.length);
  expect(r.blocked).toBe(r.attacksRun);
});

test("the corpus is non-trivial and covers all four OWASP-LLM categories", () => {
  expect(RED_TEAM_ATTACKS.length).toBeGreaterThanOrEqual(8);
  const cats = new Set(RED_TEAM_ATTACKS.map((a) => a.category));
  expect(cats).toEqual(
    new Set(["LLM01_prompt_injection", "LLM06_info_disclosure", "LLM07_insecure_tool", "LLM08_excessive_agency"]),
  );
});

test("every category reports run == blocked under the real gate", () => {
  const r = runRedTeam();
  for (const [, c] of Object.entries(r.byCategory)) {
    expect(c.blocked).toBe(c.run);
  }
});

test("TEETH: a weakened gate that allows everything surfaces every attack as a vuln", () => {
  const allowAll = (): OgiamDecision => ({
    intendedOutcome: "allow",
    effectiveOutcome: "allow",
    enforced: true,
    mode: "enforce",
    riskTier: "low",
    policyVersion: "test",
    ruleId: "TEST-ALLOW-ALL",
    reason: "weakened gate",
    wouldBlock: false,
  });
  const r = runRedTeam(RED_TEAM_ATTACKS, { buildAction, decide: allowAll });
  expect(r.vulns).toHaveLength(RED_TEAM_ATTACKS.length);
  expect(r.passRate).toBe(0);
  expect(r.vulns[0]).toMatchObject({ outcome: "allow", ruleId: "TEST-ALLOW-ALL" });
});
