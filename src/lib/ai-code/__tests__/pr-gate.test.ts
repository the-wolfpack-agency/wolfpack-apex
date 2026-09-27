/**
 * PR-gate verdict mapping + integration over a real diff.
 *
 * assessmentToVerdict is pure: a clean assessment is a success check; each
 * blocking layer becomes an action_required check whose title names the layer.
 * gatePullRequestDiff runs the REAL gate (assessChange) so a clean new-file diff
 * passes and a diff introducing a provider-signature secret is blocked - proving
 * the same deterministic gate governs an arbitrary PR, not just factory output.
 */
import { assessmentToVerdict, gatePullRequestDiff } from "@/lib/ai-code/pr-gate";
import type { ChangeAssessment } from "@/lib/ai-code/assess";

const clean = (): ChangeAssessment => ({
  securityOutcome: "allow", invariantRuleId: "R-MUTATION-ALLOW", invariantBlocked: false,
  deepScanCritical: 0, deepScanBlocking: false, handoffAllowed: true, blockedBy: null,
});

describe("assessmentToVerdict", () => {
  it("maps a clean assessment to a success check", () => {
    const v = assessmentToVerdict(clean());
    expect(v.conclusion).toBe("success");
    expect(v.title).toMatch(/passed/i);
  });

  it("maps a security block to action_required naming the layer", () => {
    const v = assessmentToVerdict({ ...clean(), securityOutcome: "block", handoffAllowed: false, blockedBy: "security" });
    expect(v.conclusion).toBe("action_required");
    expect(v.title).toMatch(/security/i);
  });

  it("maps an invariant block to action_required naming the rule", () => {
    const v = assessmentToVerdict({ ...clean(), invariantBlocked: true, invariantRuleId: "R-DEPENDENCY-ADDED-ESCALATE", handoffAllowed: false, blockedBy: "invariant" });
    expect(v.conclusion).toBe("action_required");
    expect(v.title).toMatch(/invariant/i);
  });

  it("maps a deep-scan block to action_required naming the count", () => {
    const v = assessmentToVerdict({ ...clean(), deepScanCritical: 2, deepScanBlocking: true, handoffAllowed: false, blockedBy: "deep-scan" });
    expect(v.conclusion).toBe("action_required");
    expect(v.title).toMatch(/deep scan/i);
    expect(v.summary).toContain("2 critical");
  });
});

describe("gatePullRequestDiff (real gate)", () => {
  const newFile = (path: string, line: string) =>
    `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}`;

  it("passes a clean new-file diff", async () => {
    const v = await gatePullRequestDiff(newFile("src/k.ts", "export const k = 1;"));
    expect(v.conclusion).toBe("success");
  });

  it("blocks a diff that introduces a provider-signature secret", async () => {
    const v = await gatePullRequestDiff(newFile("src/c.ts", 'export const K = "AKIA1234567890ABCDEF";'));
    expect(v.conclusion).toBe("action_required");
  });
});
