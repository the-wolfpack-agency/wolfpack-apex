/**
 * pre-pr-validate gate - EXECUTE a change's own authored tests before a real PR
 * exists, catching a self-inconsistent artifact (a model authoring a test whose
 * expected value is wrong, code that won't compile) at the source instead of via
 * a looping PR. Execution runs in GitHub's isolation (the factory-validate
 * workflow); this gate reads the result and, on the first look, dispatches it.
 *
 * The caller pushes the authored change to a validation branch, then invokes this
 * gate (a poller re-invokes until it settles):
 *   validation not dispatched  -> dispatch factory-validate, require_human (re-invoke)
 *   validation running          -> require_human (still validating, re-invoke)
 *   authored tests PASS         -> allow (safe to open the real PR)
 *   authored tests FAIL         -> require_human (self-inconsistent; do NOT open a
 *                                  looping PR - a human confirms the intended output)
 *
 * Opt-in via PREPR_VALIDATE_WORKFLOW (the installed workflow file name).
 */
import { workspaceGithubClient, getBranchHead, triggerWorkflow } from "@/lib/github-client";
import { readValidationOutcome } from "@/lib/ai-code/pre-pr-validation";
import type { GateDefinition, GateResult, GateContext } from "./types";

export interface PrePrValidateInput {
  repo: string;
  /** The validation branch the authored change was pushed to. */
  branch: string;
}

export interface PrePrValidateOutput {
  status: string;
  failing: string[];
}

function make(
  verdict: GateResult<PrePrValidateOutput>["verdict"],
  reason: string,
  ctx: GateContext,
  extra: { findings?: GateResult["findings"]; output: PrePrValidateOutput; ruleId: string },
): GateResult<PrePrValidateOutput> {
  return {
    verdict,
    output: extra.output,
    findings: extra.findings ?? [],
    reason,
    transparency: { checksRun: ["pre-pr-test-execution"], dataSeen: "the validation workflow's run conclusion. No model invoked.", modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: reason },
    audit: { gate: "pre-pr-validate", verdict, ruleId: extra.ruleId, reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
  };
}

export const prePrValidateGate: GateDefinition<PrePrValidateInput, PrePrValidateOutput> = {
  name: "pre-pr-validate",
  entitlement: "secure_agent",
  purpose: "Run a change's own authored tests in isolation BEFORE a PR is opened, so a self-inconsistent artifact (a wrong authored test, non-compiling code) is caught at the source, not via a looping PR.",
  async evaluate(input, ctx): Promise<GateResult<PrePrValidateOutput>> {
    const workflow = process.env.PREPR_VALIDATE_WORKFLOW;
    if (!workflow) {
      return make("require_human", "Pre-PR validation is not configured (PREPR_VALIDATE_WORKFLOW unset); cannot execute the authored tests. A human should verify.", ctx, { output: { status: "not_configured", failing: [] }, ruleId: "GATE-pre-pr-validate-unconfigured" });
    }
    const client = await workspaceGithubClient(ctx.workspaceId);
    if (!client.token) {
      return make("require_human", "No GitHub access configured, so pre-PR validation cannot run.", ctx, { output: { status: "no_token", failing: [] }, ruleId: "GATE-pre-pr-validate-no-token" });
    }
    const sha = await getBranchHead(client, input.repo, input.branch).catch(() => input.branch);
    const outcome = await readValidationOutcome(client, input.repo, sha);

    switch (outcome.status) {
      case "not_dispatched": {
        const ok = await triggerWorkflow(client, input.repo, workflow, input.branch).then(() => true).catch(() => false);
        return make("require_human", ok
          ? "Dispatched pre-PR validation (running the authored tests in isolation); re-invoke when it settles."
          : "Could not dispatch pre-PR validation; a human should verify.", ctx, { output: { status: ok ? "dispatched" : "dispatch_failed", failing: [] }, ruleId: "GATE-pre-pr-validate-dispatched" });
      }
      case "pending":
        return make("require_human", "Pre-PR validation is still running; re-invoke when it settles.", ctx, { output: { status: "pending", failing: [] }, ruleId: "GATE-pre-pr-validate-pending" });
      case "pass":
        return make("allow", "The change's authored tests PASS in isolation - safe to open the PR.", ctx, { output: { status: "pass", failing: [] }, ruleId: "GATE-pre-pr-validate-pass" });
      case "fail":
        return make("require_human", `The change's OWN authored tests FAIL in isolation (${outcome.failing.join(", ")}). This is a self-inconsistent artifact - not opening a looping PR. A human should confirm the intended behavior (the source or the test is wrong).`, ctx, {
          findings: [{ id: "self-inconsistent", severity: "high", detail: `authored tests fail: ${outcome.failing.join(", ")}` }],
          output: { status: "fail", failing: outcome.failing }, ruleId: "GATE-pre-pr-validate-fail",
        });
      default:
        return make("require_human", "Pre-PR validation result could not be read; a human should verify.", ctx, { output: { status: "unknown", failing: [] }, ruleId: "GATE-pre-pr-validate-unknown" });
    }
  },
};
