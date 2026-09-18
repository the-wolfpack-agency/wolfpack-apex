/**
 * The posture surface is DERIVED from the live control registry, so it cannot
 * overclaim. This pins the derivation: every control lands in exactly one group,
 * each group means what it says, and the enforced tally matches.
 */
import { POSTURE_HEADLINE, POSTURE_INTRO, POSTURE_CLOSER, POSTURE_PROOFS, postureControls } from "@/lib/builds/governance-posture";
import { CONTROL_LADDER, isEnforcing } from "@/lib/governance/control-ladder";

describe("governance posture derivation", () => {
  const g = postureControls();

  it("every control lands in exactly one group", () => {
    const grouped = g.autoEnforced.length + g.humanApproval.length + g.humanReviewed.length + g.hardening.length;
    expect(grouped).toBe(CONTROL_LADDER.length);
    expect(g.totalCount).toBe(CONTROL_LADDER.length);
  });

  it("auto-enforced controls are all enforcing and not human-in-loop", () => {
    const auto = new Set(g.autoEnforced.map((c) => c.label));
    for (const e of CONTROL_LADDER) {
      if (isEnforcing(e) && e.rung !== "human-in-loop") expect(auto.has(e.capability)).toBe(true);
    }
  });

  it("human-reviewed is exactly the advisory rung (truthfulness residual), never presented as enforced", () => {
    const reviewedLabels = new Set(g.humanReviewed.map((c) => c.label));
    const advisoryCaps = CONTROL_LADDER.filter((e) => e.rung === "advisory").map((e) => e.capability);
    expect([...reviewedLabels].sort()).toEqual([...new Set(advisoryCaps)].sort());
  });

  it("the enforced tally is the auto-enforced plus the held-for-approval controls", () => {
    expect(g.enforcedCount).toBe(g.autoEnforced.length + g.humanApproval.length);
    expect(g.enforcedCount).toBe(CONTROL_LADDER.filter(isEnforcing).length);
  });

  it("carries a headline, intro, closer, and at least three proofs", () => {
    expect(POSTURE_HEADLINE.length).toBeGreaterThan(40);
    expect(POSTURE_INTRO.length).toBeGreaterThan(40);
    expect(POSTURE_CLOSER.toLowerCase()).toContain("truthfulness");
    expect(POSTURE_PROOFS.length).toBeGreaterThanOrEqual(3);
    for (const p of POSTURE_PROOFS) {
      expect(p.title.trim().length).toBeGreaterThan(0);
      expect(p.body.trim().length).toBeGreaterThan(20);
    }
  });
});
