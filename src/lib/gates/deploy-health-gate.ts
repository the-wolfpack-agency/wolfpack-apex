/**
 * deploy-health gate - the last-resort floor.
 *
 * After a deploy, it verifies the LIVE url actually serves (a real 200 with a
 * rendered page, not a blank/error/lockout). On a broken deploy it auto-reverts a
 * FACTORY branch to the last-good SHA (restoring service) - but NEVER force-pushes
 * a protected/production branch; that escalates to a human with a loud alarm. This
 * is the guarantee the operator asked for: a bad self-deploy can never dead-end
 * the tool or lock anyone out.
 *
 *   healthy                              -> allow
 *   broken + factory branch + last-good  -> AUTO_FIX: revert to last-good, redeploy
 *   broken + protected branch            -> require_human (manual rollback; never
 *                                           force a production branch)
 *   broken + no last-good / can't verify -> require_human
 */
import { workspaceGithubClient, resetBranchTo } from "@/lib/github-client";
import type { GateDefinition, GateResult, GateContext } from "./types";

const CHECK_TIMEOUT_MS = 10_000;
const MIN_BODY = 200; // a rendered page has real content; a blank/error page does not
/** Markers of a broken deploy in the response body. */
const BROKEN_MARKERS = /Application error|A server-?side exception|DEPLOYMENT_NOT_FOUND|This deployment (?:has failed|is building)|500: Internal|404: Not Found|<title>\s*(?:Error|500|404)/i;

export interface DeployHealth {
  healthy: boolean;
  status: number | null;
  reason: string;
}

/** Fetch the live URL and judge whether it actually serves. Never throws. */
export async function checkDeployHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeployHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: { "User-Agent": "wolfpack-deploy-health" } });
    if (res.status !== 200) return { healthy: false, status: res.status, reason: `HTTP ${res.status} (not 200) - a 401/500 serves a blank page` };
    const body = await res.text().catch(() => "");
    if (body.length < MIN_BODY) return { healthy: false, status: 200, reason: `body is ${body.length} chars - the page rendered blank` };
    if (BROKEN_MARKERS.test(body)) return { healthy: false, status: 200, reason: "the page rendered an error/lockout marker" };
    return { healthy: true, status: 200, reason: "the live URL serves a rendered page (200, non-blank, no error markers)" };
  } catch (e) {
    return { healthy: false, status: null, reason: `could not reach the URL: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** A branch the factory may safely force back to a known-good SHA. NEVER a
 *  protected/production branch - reverting production is a human decision. */
function isRevertableBranch(branch: string | undefined): branch is string {
  return typeof branch === "string" && branch.startsWith("factory/");
}

export interface DeployHealthInput {
  /** The live URL the deploy serves. */
  url: string;
  /** The branch that was deployed (only a factory/* branch is auto-revertable). */
  branch?: string;
  /** The SHA to restore on a broken deploy. */
  lastGoodSha?: string;
  repo?: string;
}

export interface DeployHealthOutput {
  status: number | null;
  reverted?: { branch: string; sha: string };
}

function make(
  verdict: GateResult<DeployHealthOutput>["verdict"],
  reason: string,
  ctx: GateContext,
  extra: { modelInvoked?: string | null; findings?: GateResult["findings"]; output?: DeployHealthOutput; ruleId: string; dataSeen: string },
): GateResult<DeployHealthOutput> {
  return {
    verdict,
    output: extra.output,
    findings: extra.findings ?? [],
    reason,
    transparency: {
      checksRun: ["live-url-health(200 + rendered + no-error-markers)"],
      dataSeen: extra.dataSeen,
      modelInvoked: null, // purely deterministic - no model
      frameworksApplied: ctx.policy.frameworks,
      explanation: reason,
    },
    audit: { gate: "deploy-health", verdict, ruleId: extra.ruleId, reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
  };
}

export const deployHealthGate: GateDefinition<DeployHealthInput, DeployHealthOutput> = {
  name: "deploy-health",
  entitlement: "secure_agent",
  purpose: "Verify a deploy actually serves (a real 200 + rendered page); auto-revert a factory branch to the last-good SHA on a broken/blank deploy, or escalate a broken production deploy to a human. A bad self-deploy can never lock the tool out.",
  async evaluate(input, ctx): Promise<GateResult<DeployHealthOutput>> {
    const health = await checkDeployHealth(input.url);
    const dataSeen = `the live URL ${input.url} (HTTP status + rendered body). No model invoked.`;

    if (health.healthy) {
      return make("allow", `Deploy is healthy: ${health.reason}.`, ctx, { output: { status: health.status }, ruleId: "GATE-deploy-health-ok", dataSeen });
    }

    const findings: GateResult["findings"] = [{ id: "deploy-broken", severity: "critical", detail: health.reason }];

    // Broken. Auto-revert a factory branch; never force a production branch.
    if (isRevertableBranch(input.branch) && input.lastGoodSha && input.repo) {
      const client = await workspaceGithubClient(ctx.workspaceId);
      if (!client.token) {
        return make("require_human", `Deploy is broken (${health.reason}), but no GitHub access is configured to revert. Manual rollback required.`, ctx, { findings, output: { status: health.status }, ruleId: "GATE-deploy-health-no-token", dataSeen });
      }
      try {
        await resetBranchTo(client, input.repo, input.branch, input.lastGoodSha);
        return make("auto_fix", `Deploy is broken (${health.reason}). Reverted ${input.branch} to the last-good SHA ${input.lastGoodSha.slice(0, 8)}; a healthy deploy will follow.`, ctx, {
          findings, output: { status: health.status, reverted: { branch: input.branch, sha: input.lastGoodSha } }, ruleId: "GATE-deploy-health-reverted", dataSeen,
        });
      } catch (e) {
        return make("require_human", `Deploy is broken (${health.reason}) and the auto-revert failed (${(e as Error).message}). Manual rollback required.`, ctx, { findings, output: { status: health.status }, ruleId: "GATE-deploy-health-revert-failed", dataSeen });
      }
    }

    // Broken production branch, or nothing to revert to.
    const why = !isRevertableBranch(input.branch)
      ? "this is a protected/production branch - the factory will not force it; a human must roll back"
      : "no last-good SHA (or repo) was provided to revert to";
    return make("require_human", `Deploy is broken (${health.reason}). Escalating: ${why}.`, ctx, { findings, output: { status: health.status }, ruleId: "GATE-deploy-health-escalate", dataSeen });
  },
};
