/**
 * ci-autofix gate - the AUTO_FIX verdict made real inside the gate framework.
 *
 * Given a factory PR whose CI is red, it decides and acts in one shot:
 *   green                       -> allow
 *   mechanical + introduced +   -> AUTO_FIX: author a fix with the CLIENT's model,
 *     budget + fix clears gate      gate it (security + invariants + deep scan),
 *                                   commit it; CI re-runs. The loop keeps going.
 *   governance/policy failure   -> require_human (never edit code to pass a guardrail)
 *   budget spent / pre-existing -> require_human
 *   fix fails the safety gate   -> require_human (never commit an ungated fix)
 *   CI unreadable / still running-> require_human
 *
 * It composes the SAME proven building blocks as the internal ci-fix route
 * (attribution, failure classification, decideFixAction, assessChange, the
 * bounded history-derived budget) - the gate is the productized, model-agnostic
 * surface over them.
 *
 * Compliance interaction (by design): the fix is authored with ctx.agent, which
 * runGate has already policy-enforced. A client whose policy forbids model data
 * (allowModelData: "none") gets no agent, so the gate cannot auto-fix and returns
 * require_human - their code is never sent to a model, and the gate says so.
 */
import { workspaceGithubClient, getBranchHead, countBranchCommitsMatching, listChangedFiles, triggerWorkflow } from "@/lib/github-client";
import { fetchCiStatus, fetchCiAttribution } from "@/lib/ai-code/ci-status";
import { decideFixAction } from "@/lib/ai-code/ci-fix-loop";
import { gatherFailureContext, buildEnrichedFixPrompt, extractFailingTestFiles } from "@/lib/ai-code/ci-failure-detail";
import { classifyCiFailure } from "@/lib/ai-code/ci-failure-classify";
import { assessChange } from "@/lib/ai-code/assess";
import { commitFileChanges, filesToDiff, parseFileChanges } from "@/lib/ai-code/file-changes";
import { recordGateDecision } from "./audit";
import type { GateDefinition, GateResult, GateContext } from "./types";

const MAX_ATTEMPTS = 3;

export interface CiAutofixInput {
  repo: string;
  branch: string;
  base?: string;
  /** The task id used in the fix commit message; defaults to the branch. */
  ref?: string;
}

export interface CiAutofixOutput {
  committedFiles?: string[];
  failedChecks: string[];
}

function result(
  verdict: GateResult<CiAutofixOutput>["verdict"],
  reason: string,
  ctx: GateContext,
  extra: { checksRun: string[]; dataSeen: string; modelInvoked: string | null; findings?: GateResult["findings"]; output?: CiAutofixOutput; ruleId: string },
): GateResult<CiAutofixOutput> {
  return {
    verdict,
    output: extra.output,
    findings: extra.findings ?? [],
    reason,
    transparency: {
      checksRun: extra.checksRun,
      dataSeen: extra.dataSeen,
      modelInvoked: extra.modelInvoked,
      frameworksApplied: ctx.policy.frameworks,
      explanation: reason,
    },
    audit: { gate: "ci-autofix", verdict, ruleId: extra.ruleId, reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
  };
}

export const ciAutofixGate: GateDefinition<CiAutofixInput, CiAutofixOutput> = {
  name: "ci-autofix",
  entitlement: "secure_agent",
  purpose: "Read a PR's CI; auto-fix a mechanical failure the change introduced (author with your model, gate it, commit) or escalate a governance/policy failure to a human. Never edits code to make a guardrail pass; never commits an ungated fix.",
  async evaluate(input, ctx): Promise<GateResult<CiAutofixOutput>> {
    const base = input.base || "main";
    const ref = input.ref || input.branch;
    const baseChecks = ["ci-read"];

    const client = await workspaceGithubClient(ctx.workspaceId);
    if (!client.token) {
      return result("require_human", "No GitHub access is configured for this workspace, so CI cannot be read or a fix committed.", ctx, { checksRun: baseChecks, dataSeen: "none", modelInvoked: null, ruleId: "GATE-ci-autofix-no-token" });
    }

    const ci = await fetchCiStatus(input.repo, input.branch, ctx.workspaceId);
    if (ci.readable === false) {
      return result("require_human", `CI could not be read (${ci.unreadableReason ?? "unknown"}), so no safe decision can be made.`, ctx, { checksRun: baseChecks, dataSeen: "the PR's CI status", modelInvoked: null, ruleId: "GATE-ci-autofix-unreadable" });
    }
    if (ci.ciComplete) {
      return result("allow", "CI is fully green; ready to proceed.", ctx, { checksRun: [...baseChecks], dataSeen: "the PR's CI status", modelInvoked: null, ruleId: "GATE-ci-autofix-green", output: { failedChecks: [] } });
    }
    if (!ci.complete) {
      return result("require_human", "CI is still running; re-invoke this gate once it completes.", ctx, { checksRun: baseChecks, dataSeen: "the PR's CI status", modelInvoked: null, ruleId: "GATE-ci-autofix-pending", output: { failedChecks: ci.failedChecks } });
    }

    // Red + complete. Attribution + budget (the same tamper-proof, history-derived
    // count the internal route uses) + failure classification.
    const attribution = await fetchCiAttribution(input.repo, base, input.branch, ctx.workspaceId).catch(() => null);
    const introducedFailing = attribution ? attribution.introduced.length : undefined;
    const priorFixCommits = await countBranchCommitsMatching(client, input.repo, base, input.branch, "factory ci-fix:");

    const checks = [...baseChecks, "baseline-attribution", "failure-classification"];
    const headSha = await getBranchHead(client, input.repo, input.branch).catch(() => input.branch);
    const gathered = await gatherFailureContext(client, input.repo, headSha, input.branch, { onlyRunNames: attribution?.introduced });
    const cls = classifyCiFailure(gathered.detail, ci.failedChecks);
    const governanceFailure = cls.kind === "governance" ? { signal: cls.signal } : undefined;
    const transientFailure = cls.kind === "transient" ? { signal: cls.signal } : undefined;
    const snapshotFailure = cls.kind === "mechanical" && cls.subtype === "snapshot";

    // Deterministic lint/format fix (no model): on the first attempt at a LINT
    // failure, if a deterministic-fix workflow is configured, dispatch it (runs
    // eslint --fix / prettier in GitHub's isolation and commits) and return
    // auto_fix - the chain pauses "fixing", CI re-runs, and we re-evaluate. Opt-in
    // via env; without it, lint falls through to the model path below.
    const detWorkflow = process.env.DETERMINISTIC_FIX_WORKFLOW;
    if (cls.kind === "mechanical" && cls.subtype === "lint" && detWorkflow && priorFixCommits === 0 && (introducedFailing === undefined || introducedFailing > 0)) {
      const ok = await triggerWorkflow(client, input.repo, detWorkflow, input.branch).then(() => true).catch(() => false);
      if (ok) {
        return result("auto_fix", "Dispatched the deterministic fixer (eslint --fix / prettier) for the lint/format failure - no model. CI will re-run on its commit.", ctx, {
          checksRun: [...checks, "deterministic-fix-dispatch"], dataSeen: "the PR's CI status + failing checks. No model invoked (a deterministic fixer runs in GitHub's isolation).", modelInvoked: null,
          output: { failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-deterministic",
        });
      }
    }

    const decision = decideFixAction({ ci, attempt: priorFixCommits, maxAttempts: MAX_ATTEMPTS, introducedFailing, governanceFailure, transientFailure, snapshotFailure });

    if (decision.action === "escalate_human" || decision.action === "wait") {
      return result("require_human", decision.reason, ctx, {
        checksRun: checks, dataSeen: "the PR's CI status + failing job logs", modelInvoked: null,
        findings: governanceFailure ? [{ id: "governance", severity: "high", detail: `governance/policy gate: ${governanceFailure.signal}` }] : [],
        output: { failedChecks: ci.failedChecks }, ruleId: `GATE-ci-autofix-${governanceFailure ? "governance" : "escalate"}`,
      });
    }

    // decision.action === "author_fix": mechanical, introduced, budget remaining.
    if (!ctx.agent) {
      return result("require_human", "This change needs a code fix, but your compliance policy forbids sending code to a model (allowModelData: none), so it cannot be auto-fixed here. A human (or a policy that permits model access) is required.", ctx, {
        checksRun: [...checks, "policy-model-access"], dataSeen: "the PR's CI status + failing job logs (NOT sent to any model, per your policy)", modelInvoked: null,
        output: { failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-policy-no-model",
      });
    }

    // Author the fix with the CLIENT's (policy-enforced) model.
    const failingTests = extractFailingTestFiles(gathered.detail);
    let authoredTestStillFailing: string[] | undefined;
    if (priorFixCommits >= 1 && failingTests.length > 0) {
      const changed = new Set(await listChangedFiles(client, input.repo, base, input.branch));
      const authored = failingTests.filter((f) => changed.has(f));
      if (authored.length > 0) authoredTestStillFailing = authored;
    }
    const prompt = buildEnrichedFixPrompt({ repo: input.repo, branch: input.branch, brief: decision.reason, context: gathered, authoredTestStillFailing, subtype: cls.kind === "mechanical" ? cls.subtype : undefined });
    const reply = await ctx.agent.complete({ prompt, feature: "gate-ci-autofix" });
    const modelInvoked = reply.model_used ?? "client-model";
    const changes = parseFileChanges(reply.content);
    const authorChecks = [...checks, "author-fix", "fix-gate(security+invariants+deep-scan)"];

    if (changes.length === 0) {
      return result("require_human", "The model produced no usable fix for the failing checks; handing to a human.", ctx, {
        checksRun: authorChecks, dataSeen: "the PR's CI status + failing files, sent to your model", modelInvoked,
        output: { failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-empty",
      });
    }

    // Verify-before-commit: the autonomous fix clears the SAME deterministic gate
    // as the front door. An ungated fix (secret, injection, critical) is NEVER
    // committed - escalate instead.
    const a = await assessChange(filesToDiff(changes));
    if (!a.handoffAllowed) {
      return result("require_human", `The proposed fix did not clear the safety gate (blocked by ${a.blockedBy}); it was NOT committed. A human should review.`, ctx, {
        checksRun: authorChecks, dataSeen: "the PR's CI status + failing files, sent to your model", modelInvoked,
        findings: [{ id: a.blockedBy ?? "gate", severity: "critical", detail: `fix blocked by ${a.blockedBy}` }],
        output: { failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-fix-blocked",
      });
    }

    // Concurrency guard (gap 7): re-count the fix commits right before we write.
    // If another invocation committed between our budget read and now, abort -
    // the budget it consumed must be respected, not raced past into a double
    // commit. Re-invoke to re-evaluate the new state.
    const nowCount = await countBranchCommitsMatching(client, input.repo, base, input.branch, "factory ci-fix:");
    if (nowCount > priorFixCommits) {
      return result("require_human", `Another fix was committed to this branch concurrently (${priorFixCommits} -> ${nowCount}); not racing a second commit. Re-invoke to re-evaluate.`, ctx, {
        checksRun: [...authorChecks, "concurrency-guard"], dataSeen: "the PR's CI status + failing files, sent to your model", modelInvoked,
        output: { failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-concurrent",
      });
    }

    // Fail-closed on unauditable: record the decision to the tamper-evident
    // ledger BEFORE the irreversible commit. No audit, no action. The route sees
    // recordedSeq on the result and skips its post-hoc audit (no duplicate row).
    const pending = result("auto_fix", "Authored a gated fix for the failing checks; committing.", ctx, {
      checksRun: authorChecks, dataSeen: "the PR's CI status + failing files, sent to your model; the fix was gated before commit", modelInvoked,
      output: { failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-committed",
    });
    const { recordedSeq } = await recordGateDecision("ci-autofix", pending, ctx, input);
    if (recordedSeq === null) {
      return result("require_human", "The fix cleared the safety gate, but the decision could not be written to the tamper-evident ledger. Refusing to commit an unaudited change (no audit, no action); retry when the ledger is available.", ctx, {
        checksRun: [...authorChecks, "audit-ledger"], dataSeen: "the PR's CI status + failing files, sent to your model", modelInvoked,
        output: { failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-unauditable",
      });
    }

    // Can't-commit (gap 6): the branch may be protected, or the head may have
    // moved (conflict / non-fast-forward). Never fail opaquely - diagnose and
    // escalate. The decision is already audited; the failed commit is the outcome.
    let committed: string[];
    try {
      committed = await commitFileChanges({ client, repoFullName: input.repo, branch: input.branch, base: input.branch, changes, message: `factory ci-fix: ${ref}` });
    } catch (e) {
      const msg = (e as Error).message;
      const why = /protected|required status|branch protection|not permitted|403/i.test(msg)
        ? "the branch is protected (branch protection / required reviews)"
        : /conflict|not a fast-forward|non-fast-forward|409|is at/i.test(msg)
          ? "the branch head moved (a merge conflict / non-fast-forward)"
          : `a write error (${msg.slice(0, 120)})`;
      return result("require_human", `The fix cleared the gate and was audited, but it could not be committed: ${why}. A human should resolve it.`, ctx, {
        checksRun: [...authorChecks, "commit"], dataSeen: "the PR's CI status + failing files, sent to your model", modelInvoked,
        findings: [{ id: "commit-blocked", severity: "high", detail: why }],
        output: { failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-commit-failed",
      });
    }
    const out = result("auto_fix", `Authored and committed a fix for the failing checks (${committed.length} file(s)); CI will re-run.`, ctx, {
      checksRun: authorChecks, dataSeen: "the PR's CI status + failing files, sent to your model; the fix was gated before commit", modelInvoked,
      output: { committedFiles: committed, failedChecks: ci.failedChecks }, ruleId: "GATE-ci-autofix-committed",
    });
    out.recordedSeq = recordedSeq;
    return out;
  },
};
