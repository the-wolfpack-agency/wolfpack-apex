/**
 * AI-code review orchestrator: parse + scan an AI-authored diff, decide the gate
 * verdict, optionally attach an independent-family judge's verdicts, persist the
 * review, and return everything. Pure detection + pure gate + a best-effort
 * durable record. The judge NEVER changes the gate outcome.
 */
import { reviewDiff } from "./detect";
import { decideCodeGate } from "./gate";
import { recordReview } from "./store";
import { judgeFindings, type JudgeComplete } from "./judge";
import type { CodeReviewResult } from "./types";

export async function runCodeReview(args: {
  workspaceId: string;
  ref: string;
  author: string;
  diff: string;
  nowIso: string;
  /** Optional independent-family judge. Attaches verdicts to the findings; it
   *  does NOT change the deterministic gate outcome. */
  judge?: { complete: JudgeComplete; authorModel?: string; maxJudged?: number };
}): Promise<CodeReviewResult & { id: string }> {
  const findings = reviewDiff(args.diff);
  const verdict = decideCodeGate(findings);
  const bySeverity: Record<string, number> = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  const result: CodeReviewResult = { ref: args.ref, author: args.author, findings, verdict, bySeverity };
  if (args.judge && findings.length > 0) {
    result.judgments = await judgeFindings({
      findings,
      complete: args.judge.complete,
      authorModel: args.judge.authorModel,
      maxJudged: args.judge.maxJudged,
    });
  }
  const id = await recordReview(args.workspaceId, result, args.nowIso);
  return { ...result, id };
}
