/**
 * The Secure Agent pipeline: one governed run over an AI-authored change.
 *
 * It chains the stages that already exist, deterministically, and records the
 * result as ONE traceable run:
 *
 *   intake  - resolve the task against fixed multiple-choice questions into a
 *             FROZEN, content-hashed spec (freezeSpec). Unanswered questions fall
 *             back to their defaults and come back in `openQuestions`, so a human
 *             confirms the assumptions in one batch rather than being blocked.
 *   gate    - the deterministic gate reviews the diff (allow / escalate / block),
 *             with the independent-family judge available.
 *   repair  - on a non-allow verdict, Stage 2 re-routes to a different-lineage
 *             model, bounded, and the SAME gate re-checks every rewrite
 *             (remediateDiff subsumes the review, so there is no double scan).
 *
 * The run is READY FOR PR only when the deterministic gate ALLOWS the final diff
 * - the original one, or a repaired one it re-checked. It never merges: a human
 * opens the PR, or picks up a `needs_human` run the repair could not clear. The
 * frozen spec travels with the run so a later conformance check (not this slice)
 * can measure what shipped against what was agreed.
 */
import { resolveIntake, freezeSpec, DEFAULT_SPEC_QUESTIONS } from "./intake";
import type { FrozenSpec, SpecQuestion } from "./intake";
import { remediateDiff, type RepairComplete } from "./repair";
import type { RemediationResult } from "./repair";
import { checkConformance, type ConformanceResult } from "./conformance";
import type { CodeReviewResult } from "./types";
import type { JudgeCandidate } from "@/lib/ai/judge-selection";

export type PipelineStatus = "ready_for_pr" | "needs_human";

export interface PipelineRun {
  ref: string;
  /** The frozen, content-hashed spec this change was governed under. */
  spec: FrozenSpec;
  /** Questions left unanswered (defaulted), to confirm in one batch. */
  openQuestions: SpecQuestion[];
  /** The full Stage 2 result. For an already-passing diff its attempts are empty
   *  and no repairer ran; it still carries the final gate review. */
  remediation: RemediationResult;
  /** Convenience alias of remediation.review - the FINAL gate review of `diff`. */
  review: CodeReviewResult;
  /** How the FINAL diff measures against the frozen spec (advisory: it surfaces
   *  deviations for the human, it does NOT change the gate status). */
  conformance: ConformanceResult;
  status: PipelineStatus;
  /** The diff a human opens as a PR (gate-passing) or the last one for review. */
  diff: string;
  reason: string;
}

export async function runPipeline(args: {
  ref: string;
  /** The task description, hashed into the frozen spec. */
  prompt: string;
  /** Multiple-choice intake answers (questionId -> optionId). Off-menu throws. */
  answers?: Record<string, string>;
  questions?: readonly SpecQuestion[];
  /** The authored change this run governs. */
  diff: string;
  /** The model that AUTHORED the diff, so the repairer is a different lineage. */
  author: string;
  nowIso: string;
  review: (diff: string) => Promise<CodeReviewResult>;
  repair: RepairComplete;
  maxAttempts?: number;
  candidates?: readonly JudgeCandidate[];
}): Promise<PipelineRun> {
  // 1. Intake -> frozen spec + the batch of defaulted questions to confirm.
  const questions = args.questions ?? DEFAULT_SPEC_QUESTIONS;
  const { answers, open } = resolveIntake(questions, args.answers ?? {});
  const spec = freezeSpec(args.prompt, answers, args.nowIso);

  // 2. + 3. Gate, then Stage 2 repair on a non-allow verdict. remediateDiff does
  // the initial review itself, so this is a single governed pass.
  const remediation = await remediateDiff({
    author: args.author,
    diff: args.diff,
    review: args.review,
    repair: args.repair,
    ...(args.maxAttempts != null ? { maxAttempts: args.maxAttempts } : {}),
    ...(args.candidates != null ? { candidates: args.candidates } : {}),
  });

  // Ready for PR ONLY when the gate allowed the final diff. Everything else is a
  // human's to resolve - the pipeline never merges.
  const status: PipelineStatus = remediation.status === "clean" ? "ready_for_pr" : "needs_human";

  // Measure the FINAL diff against what the spec committed to. Advisory: it
  // surfaces deviations (missing tests, unwired analytics, an unguarded
  // migration) for the human; it does not gate the merge - the deterministic
  // security gate does that.
  const conformance = checkConformance(spec, remediation.diff);

  return {
    ref: args.ref,
    spec,
    openQuestions: open,
    remediation,
    review: remediation.review,
    conformance,
    status,
    diff: remediation.diff,
    reason: remediation.reason,
  };
}
