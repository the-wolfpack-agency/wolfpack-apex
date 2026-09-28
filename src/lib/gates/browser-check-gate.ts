/**
 * browser-check gate - run END-TO-END + ACCESSIBILITY checks against a deployed
 * preview URL, in GitHub's isolation, and decide on the result. Fills the last
 * uncovered surface: the code gates check the diff, preview-verify checks the
 * preview SERVES, but nothing ran real browser journeys / a11y against it. This
 * does - on the same runner architecture as pre-pr-validate.
 *
 * The caller supplies the preview URL; the gate dispatches factory-browser-check
 * on the first look, then reads its result (a poller re-invokes until settled):
 *   not dispatched      -> dispatch (with the url), require_human (re-invoke)
 *   running             -> require_human (still checking)
 *   e2e + a11y PASS     -> allow
 *   e2e / a11y FAIL     -> require_human (broken journey / accessibility issue -
 *                          a human reviews before promoting)
 *
 * Opt-in via BROWSER_CHECK_WORKFLOW. Deterministic decision (no model).
 */
import { workspaceGithubClient, getBranchHead, triggerWorkflow } from "@/lib/github-client";
import { readWorkflowOutcome } from "@/lib/ai-code/workflow-outcome";
import type { GateDefinition, GateResult, GateContext } from "./types";

const WORKFLOW_NAME = "factory-browser-check";

export interface BrowserCheckInput {
  repo: string;
  /** The branch whose head the dispatched check runs on (correlates the run). */
  branch: string;
  /** The preview URL to run the browser checks against. */
  previewUrl: string;
}

export interface BrowserCheckOutput {
  status: string;
  failing: string[];
}

function make(
  verdict: GateResult<BrowserCheckOutput>["verdict"],
  reason: string,
  ctx: GateContext,
  extra: { findings?: GateResult["findings"]; output: BrowserCheckOutput; ruleId: string },
): GateResult<BrowserCheckOutput> {
  return {
    verdict,
    output: extra.output,
    findings: extra.findings ?? [],
    reason,
    transparency: { checksRun: ["e2e (playwright)", "a11y (axe)"], dataSeen: "the browser-check workflow's run conclusion against the preview URL. No model invoked.", modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: reason },
    audit: { gate: "browser-check", verdict, ruleId: extra.ruleId, reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
  };
}

export const browserCheckGate: GateDefinition<BrowserCheckInput, BrowserCheckOutput> = {
  name: "browser-check",
  entitlement: "secure_agent",
  purpose: "Run end-to-end + accessibility checks against a deployed preview URL (in isolation) and stop a broken journey or a11y regression for a human before it is promoted.",
  async evaluate(input, ctx): Promise<GateResult<BrowserCheckOutput>> {
    const workflow = process.env.BROWSER_CHECK_WORKFLOW;
    if (!workflow) {
      return make("require_human", "Browser checks are not configured (BROWSER_CHECK_WORKFLOW unset); e2e/a11y could not be run. A human should verify.", ctx, { output: { status: "not_configured", failing: [] }, ruleId: "GATE-browser-check-unconfigured" });
    }
    const client = await workspaceGithubClient(ctx.workspaceId);
    if (!client.token) {
      return make("require_human", "No GitHub access configured, so browser checks cannot run.", ctx, { output: { status: "no_token", failing: [] }, ruleId: "GATE-browser-check-no-token" });
    }
    const sha = await getBranchHead(client, input.repo, input.branch).catch(() => input.branch);
    const outcome = await readWorkflowOutcome(client, input.repo, sha, WORKFLOW_NAME);

    switch (outcome.status) {
      case "not_dispatched": {
        const ok = await triggerWorkflow(client, input.repo, workflow, input.branch, { url: input.previewUrl }).then(() => true).catch(() => false);
        return make("require_human", ok
          ? "Dispatched browser checks (e2e + a11y against the preview); re-invoke when they settle."
          : "Could not dispatch browser checks; a human should verify.", ctx, { output: { status: ok ? "dispatched" : "dispatch_failed", failing: [] }, ruleId: "GATE-browser-check-dispatched" });
      }
      case "pending":
        return make("require_human", "Browser checks are still running; re-invoke when they settle.", ctx, { output: { status: "pending", failing: [] }, ruleId: "GATE-browser-check-pending" });
      case "pass":
        return make("allow", "End-to-end + accessibility checks PASS against the preview.", ctx, { output: { status: "pass", failing: [] }, ruleId: "GATE-browser-check-pass" });
      case "fail":
        return make("require_human", `Browser checks FAILED against the preview (${outcome.failing.join(", ")}) - a broken journey or accessibility regression. A human should review before promoting.`, ctx, {
          findings: [{ id: "browser-regression", severity: "high", detail: `e2e/a11y failed: ${outcome.failing.join(", ")}` }],
          output: { status: "fail", failing: outcome.failing }, ruleId: "GATE-browser-check-fail",
        });
      default:
        return make("require_human", "Browser-check result could not be read; a human should verify.", ctx, { output: { status: "unknown", failing: [] }, ruleId: "GATE-browser-check-unknown" });
    }
  },
};
