/**
 * Auto-merge policy: the conservative AND-gate that decides the one case where the
 * human merge step may be automated. The safety property is the product - every
 * condition must hold, and it is dark unless the flag is explicitly on.
 */
import { autoMergeEnabled, autoMergeEligible, type AutoMergeSignals } from "@/lib/ai-code/auto-merge";

const ok: AutoMergeSignals = { ciGreen: true, gateOutcome: "allow", touchesSensitiveSurface: false, hasTests: true };

describe("autoMergeEnabled (dark by default)", () => {
  it("off unless explicitly on", () => {
    expect(autoMergeEnabled({})).toBe(false);
    expect(autoMergeEnabled({ AI_CODE_AUTO_MERGE: "off" })).toBe(false);
    for (const v of ["on", "true", "1", "TRUE"]) expect(autoMergeEnabled({ AI_CODE_AUTO_MERGE: v })).toBe(true);
  });
});

describe("autoMergeEligible (every condition must hold)", () => {
  it("eligible only when CI green + gate allow + no sensitive surface + tests present", () => {
    expect(autoMergeEligible(ok).eligible).toBe(true);
  });
  it("NOT eligible if CI is not green", () => {
    expect(autoMergeEligible({ ...ok, ciGreen: false }).eligible).toBe(false);
  });
  it("NOT eligible on an escalate or block verdict (a human must weigh it)", () => {
    expect(autoMergeEligible({ ...ok, gateOutcome: "escalate" }).eligible).toBe(false);
    expect(autoMergeEligible({ ...ok, gateOutcome: "block" }).eligible).toBe(false);
  });
  it("NOT eligible when a sensitive surface is touched (migration/auth/crypto/gate/CSP/infra)", () => {
    expect(autoMergeEligible({ ...ok, touchesSensitiveSurface: true }).eligible).toBe(false);
  });
  it("NOT eligible without tests (change must carry its own verification)", () => {
    expect(autoMergeEligible({ ...ok, hasTests: false }).eligible).toBe(false);
  });
  it("gives a reason for the decision (observability)", () => {
    expect(autoMergeEligible({ ...ok, gateOutcome: "escalate" }).reason).toMatch(/escalate/);
    expect(autoMergeEligible(ok).reason).toMatch(/low-risk tail/);
  });
});
