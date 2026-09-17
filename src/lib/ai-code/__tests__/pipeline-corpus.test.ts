/**
 * Adversarial corpus: prove the pipeline ACCEPTS good code, REJECTS bad code,
 * and FLAGS bad process - across every failure mode we know.
 *
 * This is the efficacy proof a buyer asks for ("show me it actually stops the
 * bad stuff"), and a permanent regression guard. It runs the REAL detector +
 * gate + conformance (not mocks), so every verdict is the shipped behavior; only
 * the repair MODEL is injected. A repair that never produces a real fix is used
 * for the bad-code cases, which proves the gate HOLDS even when the model does
 * not help: bad code is never handed off as ready_for_pr.
 */
import { runPipeline } from "../pipeline";
import { reviewDiff } from "../detect";
import { decideCodeGate } from "../gate";
import type { CodeReviewResult } from "../types";
import type { RepairComplete } from "../repair";
import type { JudgeCandidate } from "@/lib/ai/judge-selection";

function realReview(diff: string): Promise<CodeReviewResult> {
  const findings = reviewDiff(diff);
  return Promise.resolve({ ref: "r", author: "a", findings, verdict: decideCodeGate(findings), bySeverity: {} });
}

// Corpus + diff helpers are the shared fixture (also used by the multi-model
// matrix) so both proofs cover the exact same cases. See ./corpus.
import { CORPUS } from "./corpus";

const AUTHOR = "claude-3-5-sonnet";
const INDEPENDENT: JudgeCandidate[] = [{ model: "gpt-4o-mini", provider: "openai" }];
const NOW = "2026-09-17T00:00:00.000Z";
/** A repair that never yields a real fix (empty -> cheat guard rejects it), so a
 *  bad-code case can only end in needs_human - the gate is never talked past. */
const noFixRepair: RepairComplete = async () => "";

describe("Secure Agent pipeline — adversarial corpus", () => {
  for (const c of CORPUS) {
    it(c.name, async () => {
      const run = await runPipeline({
        ref: "corpus",
        prompt: "task",
        answers: c.answers,
        diff: c.diff,
        author: AUTHOR,
        nowIso: NOW,
        review: realReview,
        repair: noFixRepair,
        candidates: INDEPENDENT,
      });

      expect(run.status).toBe(c.expect.status);
      // Bad code is NEVER handed off ready for a PR.
      if (c.expect.status === "needs_human") {
        expect(run.status).not.toBe("ready_for_pr");
        expect(run.review.verdict.outcome).not.toBe("allow");
      }
      expect(run.conformance.conforms).toBe(c.expect.conforms);
      if (c.expect.deviation) {
        const f = run.conformance.findings.find((x) => x.requirement === c.expect.deviation);
        expect(f?.ok).toBe(false);
      }
    });
  }

  it("covers accept, reject-code, and flag-process (no failure mode left untested)", () => {
    const accepts = CORPUS.filter((c) => c.expect.status === "ready_for_pr" && c.expect.conforms);
    const rejectsCode = CORPUS.filter((c) => c.expect.status === "needs_human");
    const flagsProcess = CORPUS.filter((c) => c.expect.status === "ready_for_pr" && !c.expect.conforms);
    expect(accepts.length).toBeGreaterThanOrEqual(1);
    expect(rejectsCode.length).toBeGreaterThanOrEqual(4);
    expect(flagsProcess.length).toBeGreaterThanOrEqual(3);
  });
});
