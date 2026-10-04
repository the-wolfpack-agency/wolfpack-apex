/**
 * PR-gate verdict mapping + integration over a real diff.
 *
 * assessmentToVerdict is pure: a clean assessment is a success check; each
 * blocking layer becomes an action_required check whose title names the layer.
 * gatePullRequestDiff runs the REAL gate (assessChange) so a clean new-file diff
 * passes and a diff introducing a provider-signature secret is blocked - proving
 * the same deterministic gate governs an arbitrary PR, not just factory output.
 */
import { assessmentToVerdict, gatePullRequestDiff, evaluatePrPolicy, applyPolicyToVerdict } from "@/lib/ai-code/pr-gate";
import * as policyStore from "@/lib/ai-code/policy-store";
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

describe("evaluatePrPolicy (org policy over a PR diff)", () => {
  const diff = (path: string, ...lines: string[]) =>
    `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => `+${l}`).join("\n");

  it("empty policy is a no-op", () => {
    const r = evaluatePrPolicy(diff("a.ts", "x"), { protectedPaths: [], denyRules: [] });
    expect(r).toEqual({ findings: [], blockingFindings: 0, protectedPaths: [] });
  });

  it("flags an added line matching a deny rule and counts blocking by severity", () => {
    const policy = { protectedPaths: [], denyRules: [
      { title: "no moment.js", pattern: "require\\(['\"]moment", severity: "high" as const },
      { title: "no console.debug", pattern: "console\\.debug", severity: "low" as const },
    ] };
    const r = evaluatePrPolicy(diff("src/a.ts", "const m = require('moment');", "console.debug('x');"), policy);
    expect(r.findings).toHaveLength(2);
    expect(r.blockingFindings).toBe(1); // only the HIGH one blocks; low is advisory
  });

  it("only scans ADDED lines, not context/removed", () => {
    const policy = { protectedPaths: [], denyRules: [{ title: "no foo", pattern: "foo", severity: "critical" as const }] };
    // 'foo' appears only on a context line (leading space), never added
    const d = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n foo_context\n+bar_added`;
    expect(evaluatePrPolicy(d, policy).findings).toHaveLength(0);
  });

  it("lists protected paths the PR touches", () => {
    const policy = { protectedPaths: ["src/lib/crypto/"], denyRules: [] };
    const r = evaluatePrPolicy(diff("src/lib/crypto/keys.ts", "x"), policy);
    expect(r.protectedPaths).toEqual(["src/lib/crypto/keys.ts"]);
  });
});

describe("applyPolicyToVerdict", () => {
  const base = assessmentToVerdict(clean()); // success

  it("keeps a clean verdict clean and notes the policy ran", () => {
    const v = applyPolicyToVerdict(base, { findings: [], blockingFindings: 0, protectedPaths: [] });
    expect(v.conclusion).toBe("success");
    expect(v.summary).toMatch(/Org policy: clear/);
  });

  it("flips an otherwise-clean verdict to action_required on a blocking deny-finding", () => {
    const v = applyPolicyToVerdict(base, { findings: [{ route: "a.ts:1", severity: "high", category: "security", title: "no moment", detail: "", evidence: {} }], blockingFindings: 1, protectedPaths: [] });
    expect(v.conclusion).toBe("action_required");
    expect(v.title).toMatch(/org-policy violation/i);
  });

  it("requires a human when a protected path is touched, even with zero findings", () => {
    const v = applyPolicyToVerdict(base, { findings: [], blockingFindings: 0, protectedPaths: ["src/lib/crypto/keys.ts"] });
    expect(v.conclusion).toBe("action_required");
    expect(v.title).toMatch(/protected path/i);
  });
});

describe("gatePullRequestDiff with a workspace policy", () => {
  const newFile = (path: string, line: string) =>
    `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}`;

  afterEach(() => jest.restoreAllMocks());

  it("blocks a built-in-clean diff that violates the workspace deny policy", async () => {
    jest.spyOn(policyStore, "loadCodeGatePolicy").mockResolvedValue({
      protectedPaths: [], denyRules: [{ title: "no raw fetch", pattern: "\\bfetch\\(", severity: "high" }],
    });
    const v = await gatePullRequestDiff(newFile("src/x.ts", "await fetch('/api/x');"), { workspaceId: "w1" });
    expect(v.conclusion).toBe("action_required");
    expect(v.policy?.blockingFindings).toBe(1);
  });

  it("no workspaceId -> built-in gate only (policy never loaded)", async () => {
    const spy = jest.spyOn(policyStore, "loadCodeGatePolicy");
    const v = await gatePullRequestDiff(newFile("src/x.ts", "export const k = 1;"));
    expect(v.conclusion).toBe("success");
    expect(v.policy).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a policy-load failure degrades to the built-in gate (never weakens it)", async () => {
    jest.spyOn(policyStore, "loadCodeGatePolicy").mockRejectedValue(new Error("db down"));
    const v = await gatePullRequestDiff(newFile("src/x.ts", "export const k = 1;"), { workspaceId: "w1" });
    expect(v.conclusion).toBe("success"); // clean built-in gate still stands
  });
});
