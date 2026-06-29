/**
 * AI-code review orchestrator: parse + scan an AI-authored diff, decide the gate
 * verdict, persist the review, and return everything. Pure detection + pure gate
 * + a best-effort durable record.
 */
import { reviewDiff } from "./detect";
import { decideCodeGate } from "./gate";
import { recordReview } from "./store";
import type { CodeReviewResult } from "./types";

export async function runCodeReview(args: {
  workspaceId: string;
  ref: string;
  author: string;
  diff: string;
  nowIso: string;
}): Promise<CodeReviewResult & { id: string }> {
  const findings = reviewDiff(args.diff);
  const verdict = decideCodeGate(findings);
  const bySeverity: Record<string, number> = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;

  const result: CodeReviewResult = { ref: args.ref, author: args.author, findings, verdict, bySeverity };
  const id = await recordReview(args.workspaceId, result, args.nowIso);
  return { ...result, id };
}
