/**
 * preview-verify gate - the automated verification between a green PR and the
 * human's production decision.
 *
 * After a PR's CI is green it auto-deploys to a PREVIEW url; this gate confirms
 * that preview actually serves the full treatment (a real 200 + rendered page, no
 * error/lockout) and optionally that named content markers render. It NEVER
 * promotes on its own - a healthy preview hands off (allow) to the prod gate,
 * where a human makes the only production decision; a broken preview stops for a
 * human (require_human), never auto-promoted.
 *
 *   preview healthy (+ markers) -> allow  (hand the preview url to the prod gate)
 *   preview broken / unreachable-> require_human (never promote a broken preview)
 *
 * Deterministic: no model. Reuses checkDeployHealth so "does it serve" is judged
 * the same way everywhere.
 */
import { checkDeployHealth } from "./deploy-health-gate";
import type { GateDefinition, GateResult, GateContext } from "./types";

export interface PreviewVerifyInput {
  /** The preview URL the green PR deployed to. */
  url: string;
  /** Optional content markers that MUST appear in the rendered page (a widget's
   *  text, a heading) - the "full test treatment" beyond a bare 200. */
  requiredMarkers?: string[];
}

export interface PreviewVerifyOutput {
  previewUrl: string;
  status: number | null;
}

function make(
  verdict: GateResult<PreviewVerifyOutput>["verdict"],
  reason: string,
  ctx: GateContext,
  extra: { checksRun: string[]; findings?: GateResult["findings"]; output?: PreviewVerifyOutput; ruleId: string },
): GateResult<PreviewVerifyOutput> {
  return {
    verdict,
    output: extra.output,
    findings: extra.findings ?? [],
    reason,
    transparency: {
      checksRun: extra.checksRun,
      dataSeen: "the preview URL (HTTP status + rendered body). No model invoked.",
      modelInvoked: null,
      frameworksApplied: ctx.policy.frameworks,
      explanation: reason,
    },
    audit: { gate: "preview-verify", verdict, ruleId: extra.ruleId, reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
  };
}

export const previewVerifyGate: GateDefinition<PreviewVerifyInput, PreviewVerifyOutput> = {
  name: "preview-verify",
  entitlement: "secure_agent",
  purpose: "Verify a PR's preview deploy actually serves the full treatment (real 200 + rendered page + required markers) before a human is asked to promote it. Never promotes on its own; a broken preview stops for a human.",
  async evaluate(input, ctx): Promise<GateResult<PreviewVerifyOutput>> {
    const health = await checkDeployHealth(input.url);
    const checks = ["preview-health(200 + rendered + no-error-markers)"];

    if (!health.healthy) {
      return make("require_human", `Preview is not serving (${health.reason}); not handing it to the production decision. A human should investigate.`, ctx, {
        checksRun: checks, findings: [{ id: "preview-broken", severity: "high", detail: health.reason }],
        output: { previewUrl: input.url, status: health.status }, ruleId: "GATE-preview-verify-broken",
      });
    }

    // Full-treatment markers: the page must render the named content, not just 200.
    if (input.requiredMarkers && input.requiredMarkers.length > 0) {
      const body = await fetch(input.url).then((r) => r.text()).catch(() => "");
      const missing = input.requiredMarkers.filter((m) => !body.includes(m));
      checks.push(`content-markers(${input.requiredMarkers.length})`);
      if (missing.length > 0) {
        return make("require_human", `Preview serves a 200 but is missing expected content: ${missing.join(", ")}. A human should check before promoting.`, ctx, {
          checksRun: checks, findings: missing.map((m) => ({ id: "missing-marker", severity: "medium" as const, detail: `missing: ${m}` })),
          output: { previewUrl: input.url, status: health.status }, ruleId: "GATE-preview-verify-markers-missing",
        });
      }
    }

    return make("allow", `Preview verified: ${health.reason}. Ready for the human production decision.`, ctx, {
      checksRun: checks, output: { previewUrl: input.url, status: health.status }, ruleId: "GATE-preview-verify-ok",
    });
  },
};
