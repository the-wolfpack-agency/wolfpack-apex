/**
 * The Secure Agent pipeline: intake -> gate -> Stage 2 repair, as one run.
 *
 * The gate is the REAL detector + gate (not a mock), so "ready_for_pr" here
 * means the shipped gate actually allowed the final diff. Only the repair model
 * is injected.
 */
import { runPipeline } from "../pipeline";
import { reviewDiff } from "../detect";
import { decideCodeGate } from "../gate";
import type { CodeReviewResult } from "../types";
import type { RepairComplete } from "../repair";
import type { JudgeCandidate } from "@/lib/ai/judge-selection";

function realReview(diff: string): Promise<CodeReviewResult> {
  const findings = reviewDiff(diff);
  const verdict = decideCodeGate(findings);
  return Promise.resolve({ ref: "r", author: "a", findings, verdict, bySeverity: {} });
}

function makeDiff(addedLine: string): string {
  return [
    "diff --git a/config.ts b/config.ts",
    "--- a/config.ts",
    "+++ b/config.ts",
    "@@ -1,1 +1,2 @@",
    " export const base = 1;",
    `+${addedLine}`,
    "",
  ].join("\n");
}

const CLEAN_INPUT = makeDiff("export const y = 2;");
const BLOCKED = makeDiff('const apiKey = "aVerySecretValue12345";');
const CLEAN_REPAIR = makeDiff("const apiKey = process.env.API_KEY;");

const AUTHOR = "claude-3-5-sonnet";
const INDEPENDENT: JudgeCandidate[] = [{ model: "gpt-4o-mini", provider: "openai" }];
const SAME_FAMILY: JudgeCandidate[] = [{ model: "claude-3-haiku", provider: "anthropic" }];
const NOW = "2026-09-17T00:00:00.000Z";

function scriptedRepair(outputs: string[]): RepairComplete {
  let i = 0;
  return async () => outputs[Math.min(i++, outputs.length - 1)];
}

const base = {
  ref: "pr-1",
  prompt: "Add a config value",
  author: AUTHOR,
  nowIso: NOW,
  review: realReview,
  candidates: INDEPENDENT,
};

describe("runPipeline", () => {
  it("a clean diff with full answers is ready for PR, with no open questions and no repair", async () => {
    const run = await runPipeline({
      ...base,
      diff: CLEAN_INPUT,
      answers: { tests: "all", data: "analytics", reversibility: "reversible" },
      repair: scriptedRepair(["unused"]),
    });
    expect(run.status).toBe("ready_for_pr");
    expect(run.openQuestions).toHaveLength(0);
    expect(run.remediation.attempts).toHaveLength(0);
    expect(run.spec.hash).toMatch(/^spec_/);
    expect(run.spec.answers).toEqual({ tests: "all", data: "analytics", reversibility: "reversible" });
  });

  it("freezes a spec from DEFAULTS and returns the defaulted questions to confirm", async () => {
    const run = await runPipeline({ ...base, diff: CLEAN_INPUT, repair: scriptedRepair(["unused"]) });
    // Every default question is unanswered -> all come back as open, defaulted.
    expect(run.openQuestions.map((q) => q.id).sort()).toEqual(["data", "reversibility", "tests"]);
    expect(run.spec.answers).toEqual({ tests: "all", data: "analytics", reversibility: "reversible" });
    expect(run.status).toBe("ready_for_pr");
  });

  it("re-routes a BLOCKED diff and reaches ready_for_pr when the repair passes", async () => {
    const run = await runPipeline({ ...base, diff: BLOCKED, repair: scriptedRepair([CLEAN_REPAIR]) });
    expect(run.status).toBe("ready_for_pr");
    expect(run.diff).toBe(CLEAN_REPAIR.trim());
    expect(run.remediation.attempts).toHaveLength(1);
    expect(run.remediation.repairerLineage).toBe("openai");
    expect(run.review.verdict.outcome).toBe("allow");
  });

  it("a BLOCKED diff with no independent repairer goes to needs_human, never merged", async () => {
    const run = await runPipeline({
      ...base,
      candidates: SAME_FAMILY,
      diff: BLOCKED,
      repair: scriptedRepair([CLEAN_REPAIR]),
    });
    expect(run.status).toBe("needs_human");
    expect(run.review.verdict.outcome).toBe("block");
  });

  it("the frozen spec hash is stable for the same prompt + answers", async () => {
    const a = await runPipeline({ ...base, diff: CLEAN_INPUT, answers: { tests: "unit" }, repair: scriptedRepair(["x"]) });
    const b = await runPipeline({ ...base, diff: CLEAN_INPUT, answers: { tests: "unit" }, repair: scriptedRepair(["x"]) });
    expect(a.spec.hash).toBe(b.spec.hash);
  });

  it("rejects an off-menu intake answer (the answer space is fixed)", async () => {
    await expect(
      runPipeline({ ...base, diff: CLEAN_INPUT, answers: { tests: "eventually" }, repair: scriptedRepair(["x"]) }),
    ).rejects.toThrow(/unknown option/i);
  });

  it("attaches a conformance measurement of the final diff against the frozen spec", async () => {
    // A gate-clean code diff with no tests, against a spec that demanded them:
    // gate passes (security), conformance flags the missing coverage (advisory).
    const run = await runPipeline({
      ...base,
      diff: CLEAN_INPUT,
      answers: { tests: "all" },
      repair: scriptedRepair(["x"]),
    });
    expect(run.status).toBe("ready_for_pr"); // the SECURITY gate is clean
    expect(run.conformance.specHash).toBe(run.spec.hash);
    expect(run.conformance.conforms).toBe(false); // ...but it skipped required tests
    expect(run.conformance.findings.find((f) => f.requirement === "tests")?.ok).toBe(false);
  });
});
