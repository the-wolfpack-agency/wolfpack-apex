/**
 * Proof for the Secure Agent gate. The headline case reintroduces the exact
 * defect that motivated this build — a raw password-reset link written to a log
 * — and asserts the gate FAILS CLOSED on it, and that a clean change passes.
 * The rest pin the governing invariants: the model judge never overturns a
 * hard-block, and a missing independent family is recorded UNCHECKED, not
 * rubber-stamped.
 */
import { runSecureAgentGate, type FindingJudge } from "@/lib/secure-agent/pipeline";
import type { JudgeCandidate } from "@/lib/ai/judge-selection";

const AUTHOR: JudgeCandidate = { provider: "azure-openai", model: "azure-gpt-4o-mini" }; // openai
const INDEPENDENT: JudgeCandidate[] = [{ provider: "azure-ai-foundry", model: "azure-deepseek-v3" }]; // deepseek
const SIBLINGS: JudgeCandidate[] = [{ provider: "openai", model: "gpt-4o" }]; // openai — same family

const RESET_LINK_LEAK = {
  path: "lib/admin/password-reset.ts",
  content: [
    "export async function requestReset(resetUrl: string) {",
    "  console.log(`password reset link issued: ${resetUrl}`);",
    "  return { ok: true };",
    "}",
  ].join("\n"),
};

const CLEAN = {
  path: "lib/admin/password-reset.ts",
  content: [
    "export async function requestReset(resetUrl: string) {",
    "  console.log('password reset link issued for', maskEmail(email));",
    "  return { ok: true };",
    "}",
  ].join("\n"),
};

// A soft (high/bug, non-security) finding: fetch consumed without an ok check.
const SILENT_FETCH = {
  path: "app/dashboard/page.tsx",
  content: ["async function load() {", "  const res = await fetch(`/api/leads`);", "  const data = await res.json();", "  return data;", "}"].join("\n"),
};

describe("runSecureAgentGate", () => {
  it("BLOCKS a change that logs a password reset link (the motivating defect)", async () => {
    const v = await runSecureAgentGate({ files: [RESET_LINK_LEAK] });
    expect(v.decision).toBe("block");
    expect(v.blocking.length).toBeGreaterThan(0);
    expect(v.blocking[0].category).toBe("security");
    expect(v.blocking[0].title).toMatch(/credential written to a log/i);
  });

  it("PASSES a clean change with no credential in any log", async () => {
    const v = await runSecureAgentGate({ files: [CLEAN] });
    expect(v.decision).toBe("pass");
    expect(v.blocking).toHaveLength(0);
  });

  it("does not let the model judge overturn a hard-block", async () => {
    const alwaysRefutes: FindingJudge = async () => ({ verdict: "false_positive", reason: "stub says fine" });
    const v = await runSecureAgentGate({
      files: [RESET_LINK_LEAK],
      author: AUTHOR,
      judgeCandidates: INDEPENDENT,
      judge: alwaysRefutes,
    });
    // Judge opinion is attached...
    expect(v.judgments.some((j) => j.verdict === "false_positive")).toBe(true);
    expect(v.judgments[0].judgeLineage).toBe("deepseek");
    // ...but the deterministic hard-block still decides.
    expect(v.decision).toBe("block");
  });

  it("records UNCHECKED and still blocks when no independent-family judge exists", async () => {
    const judge: FindingJudge = async () => ({ verdict: "confirmed", reason: "should not be called" });
    const v = await runSecureAgentGate({
      files: [RESET_LINK_LEAK],
      author: AUTHOR,
      judgeCandidates: SIBLINGS, // same family as author -> no independent judge
      judge,
    });
    expect(v.unchecked).toBe(true);
    expect(v.judgments.every((j) => j.verdict === "unchecked")).toBe(true);
    expect(v.judgments[0].reason).toBe("no_independent_lineage_configured");
    expect(v.decision).toBe("block"); // hard-block does not depend on the judge
  });

  it("blocks a SOFT finding only when the independent judge confirms it", async () => {
    const confirms: FindingJudge = async () => ({ verdict: "confirmed", reason: "real bug" });
    const refutes: FindingJudge = async () => ({ verdict: "false_positive", reason: "guarded elsewhere" });

    const blocked = await runSecureAgentGate({ files: [SILENT_FETCH], author: AUTHOR, judgeCandidates: INDEPENDENT, judge: confirms });
    expect(blocked.decision).toBe("block");

    const passed = await runSecureAgentGate({ files: [SILENT_FETCH], author: AUTHOR, judgeCandidates: INDEPENDENT, judge: refutes });
    expect(passed.decision).toBe("pass");
    expect(passed.warnings.length).toBeGreaterThan(0); // surfaced, not blocking
  });

  it("still returns a decision when the audit sink throws (recording never gates)", async () => {
    const v = await runSecureAgentGate({
      files: [RESET_LINK_LEAK],
      audit: () => {
        throw new Error("ledger down");
      },
    });
    expect(v.decision).toBe("block");
  });
});
