/**
 * The capability ladder: cheapest model first, escalate only when it cannot meet
 * the standard.
 *
 * This is how the factory proves model efficiency AND stays model-agnostic. Each
 * tier (cheap -> standard -> premium) is asked to author the change; the diff is
 * run against a deterministic ORACLE (its tests must pass) before it counts as a
 * pass. A model that games the oracle - editing the graded test, weakening the
 * gate, deleting test cases - is rejected before the oracle even runs, so a
 * "pass" is always earned. The ladder stops at the first tier that clears the
 * bar, records which tier that was, and reports the spend.
 *
 * The lesson compounds: over many tasks, "which tier cleared this" is the
 * capability boundary of each model, learned rather than assumed - and it lets
 * the router spend the cheapest dollar that still meets the standard.
 *
 * The oracle here is the CAPABILITY standard (did the model do the task). It is
 * distinct from the SECURITY gate (is the code safe to ship), which runs
 * separately in runPipeline and is the last line before any output.
 *
 * Pure orchestration: author + oracle are injected, so this unit-tests without a
 * model or a subprocess.
 */
import { detectOracleGaming, type GamingReason } from "@/lib/ai/code-screen";
import type { AIModelTier } from "@/lib/ai/types";
import type { AuthorResult } from "./author";

export const DEFAULT_LADDER: readonly AIModelTier[] = ["cheap", "standard", "premium"];

export interface LadderTask {
  id: string;
  prompt: string;
  /** Test files that grade this task and must never be edited by the diff. When
   *  present, a diff that touches them (or weakens the gate / deletes tests) is
   *  rejected as gaming before the oracle runs. */
  gradedBy?: readonly string[];
}

export interface OracleResult {
  passed: boolean;
  /** One line of why - the failing assertion, a compile error, a timeout. */
  detail: string;
}

/** Run the authored diff against the capability standard (execute its tests). */
export type RunOracle = (diff: string, task: LadderTask) => Promise<OracleResult>;

/** Author a diff at a specific capability tier (pins the tier upstream). */
export type AuthorAtTier = (tier: AIModelTier, task: LadderTask) => Promise<AuthorResult>;

export interface TierAttempt {
  tier: AIModelTier;
  author: string;
  provider: string | null;
  diffPresent: boolean;
  gamed: boolean;
  gamingReasons: GamingReason[];
  oraclePassed: boolean;
  oracleDetail: string;
  costUsd: number | null;
  error: string | null;
}

export interface LadderResult {
  taskId: string;
  attempts: TierAttempt[];
  /** The first tier that authored a non-gaming diff the oracle passed. */
  clearedBy: AIModelTier | null;
  totalCostUsd: number;
  summary: string;
}

function gamingCheck(diff: string, task: LadderTask): { gamed: boolean; reasons: GamingReason[] } {
  if (!task.gradedBy || task.gradedBy.length === 0) return { gamed: false, reasons: [] };
  // detectOracleGaming reads only gradedBy + the patch; baseCommit/targetFile are
  // unused by it, so a minimal task shape is enough here.
  const v = detectOracleGaming(diff, { id: task.id, prompt: task.prompt, baseCommit: "", targetFile: "", gradedBy: [...task.gradedBy] });
  return { gamed: v.gamed, reasons: v.reasons };
}

/**
 * Walk the tiers cheapest-first. Stop at the first tier whose (non-gaming) diff
 * the oracle passes. Never throws: an unavailable tier or a failing oracle is a
 * recorded attempt, and the ladder moves on.
 */
export async function runCapabilityLadder(args: {
  task: LadderTask;
  tiers?: readonly AIModelTier[];
  author: AuthorAtTier;
  runOracle: RunOracle;
}): Promise<LadderResult> {
  const tiers = args.tiers ?? DEFAULT_LADDER;
  const attempts: TierAttempt[] = [];
  let clearedBy: AIModelTier | null = null;

  for (const tier of tiers) {
    const authored = await args.author(tier, args.task);
    const attempt: TierAttempt = {
      tier,
      author: authored.author,
      provider: authored.provider,
      diffPresent: Boolean(authored.diff.trim()),
      gamed: false,
      gamingReasons: [],
      oraclePassed: false,
      oracleDetail: "",
      costUsd: authored.costUsd,
      error: authored.error,
    };

    if (!attempt.diffPresent) {
      attempt.oracleDetail = authored.error ? "executor unavailable" : "no diff authored";
      attempts.push(attempt);
      continue; // escalate: this tier could not produce a change
    }

    const g = gamingCheck(authored.diff, args.task);
    if (g.gamed) {
      attempt.gamed = true;
      attempt.gamingReasons = g.reasons;
      attempt.oracleDetail = `rejected as gaming: ${g.reasons.join(", ")}`;
      attempts.push(attempt);
      continue; // a gamed diff is never a pass
    }

    const oracle = await args.runOracle(authored.diff, args.task);
    attempt.oraclePassed = oracle.passed;
    attempt.oracleDetail = oracle.detail;
    attempts.push(attempt);
    if (oracle.passed) {
      clearedBy = tier;
      break; // stop at the first tier that meets the standard
    }
  }

  const totalCostUsd = attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
  const summary = clearedBy
    ? `cleared by the ${clearedBy} tier after ${attempts.length} attempt(s); spent $${totalCostUsd.toFixed(5)}`
    : `no tier met the standard across ${attempts.length} attempt(s); spent $${totalCostUsd.toFixed(5)}`;

  return { taskId: args.task.id, attempts, clearedBy, totalCostUsd, summary };
}
