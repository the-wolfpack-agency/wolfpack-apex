/**
 * Revert a factory PR branch to a known-good checkpoint.
 *
 * Two callers: a MANUAL "revert last change" button, and the AUTO-revert path
 * when a canary deploy fails (see canary.ts decideCanaryAction). Both undo the
 * agent's autonomous commits and restore the branch to the last-good SHA.
 *
 * Safety - the user stays in control of their product and our automation can
 * never touch it in a way they did not initiate:
 *   - It only ever resets branches the factory CREATED (the "factory/" prefix).
 *     A human branch, a release branch, or main can never be rewritten by this.
 *   - The GitHub client is the tenant's own workspace client, so it can only
 *     reach repos that tenant's token authorizes - never ours.
 *   - It is governed exactly like the PR-open: the OGIAM gate authorizes it and
 *     the hash-chained ledger records the outcome, so every revert is auditable.
 */
import { getBranchHead, resetBranchTo, type GithubClient } from "@/lib/github-client";
import { authorize } from "@/lib/ogiam/authorize";
import { recordActionOutcome } from "@/lib/ogiam/ledger";

/** The factory only reverts branches it created (open-pr-executor names them
 *  `factory/<ref>-<hash>`). This prefix is the guarantee it never rewrites a
 *  branch a human owns. */
export const FACTORY_BRANCH_PREFIX = "factory/";
export function isFactoryBranch(branch: string): boolean {
  return branch.startsWith(FACTORY_BRANCH_PREFIX) && branch.length > FACTORY_BRANCH_PREFIX.length;
}

export type RevertOutcome =
  | { ok: true; branch: string; revertedTo: string; from: string }
  | { ok: false; reason: string };

export interface RevertArgs {
  client: GithubClient;
  repoFullName: string;
  branch: string;
  /** The last-good commit to restore the branch to. */
  toSha: string;
  workspaceId: string;
  userId: string;
  userRole: string;
  /** How the revert was triggered, for the audit reason. */
  trigger: "manual" | "canary_auto";
}

export async function revertFactoryBranch(args: RevertArgs): Promise<RevertOutcome> {
  // Guard 1: only factory-created branches. This is the hard line that keeps our
  // automation off the user's own branches.
  if (!isFactoryBranch(args.branch)) {
    return {
      ok: false,
      reason: `refusing to revert "${args.branch}": the factory only reverts branches it created (${FACTORY_BRANCH_PREFIX}...)`,
    };
  }
  // Guard 2: the target must look like a commit sha, never a branch name or ref.
  if (!/^[0-9a-f]{7,40}$/i.test(args.toSha)) {
    return { ok: false, reason: "toSha is not a valid commit sha" };
  }

  // Governed like every factory mutation: authorize through the OGIAM gate and
  // record the outcome on the hash-chained ledger (monitor mode records without
  // blocking; an enforce-mode block short-circuits before any write).
  const decision = await authorize({
    principal: {
      kind: "ai_agent",
      agent: "instinct.ai_code",
      onBehalfOfUserId: args.userId,
      onBehalfOfRole: args.userRole,
      workspaceId: args.workspaceId,
    },
    tool: "ai_code.revert",
    capability: "code.write",
    isMutation: true,
    surface: "/agent",
    params: { repo: args.repoFullName, branch: args.branch, toSha: args.toSha, trigger: args.trigger },
    mode: "monitor",
  });
  const startMs = Date.now();
  const recordOutcome = async (ok: boolean, code: string, result: string): Promise<void> => {
    if (decision.recordedSeq == null) return;
    await recordActionOutcome({
      workspaceId: args.workspaceId,
      decisionSeq: decision.recordedSeq,
      agentId: "instinct.ai_code",
      ok,
      code,
      resultRedacted: result,
      durationMs: Date.now() - startMs,
    }).catch(() => {});
  };

  if (decision.enforced && decision.effectiveOutcome !== "allow") {
    await recordOutcome(false, "gate_blocked", `${decision.ruleId}: ${decision.reason}`);
    return { ok: false, reason: `gate_blocked: ${decision.ruleId} (${decision.reason})` };
  }

  try {
    const from = await getBranchHead(args.client, args.repoFullName, args.branch);
    if (from === args.toSha) {
      await recordOutcome(false, "noop", "branch already at target sha");
      return { ok: false, reason: "branch is already at the target version; nothing to revert" };
    }
    await resetBranchTo(args.client, args.repoFullName, args.branch, args.toSha);
    await recordOutcome(true, "ok", `${args.branch}: ${from.slice(0, 8)} -> ${args.toSha.slice(0, 8)} (${args.trigger})`);
    return { ok: true, branch: args.branch, revertedTo: args.toSha, from };
  } catch (err) {
    await recordOutcome(false, "error", (err as Error).message);
    return { ok: false, reason: (err as Error).message };
  }
}
