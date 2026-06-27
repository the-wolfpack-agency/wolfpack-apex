/**
 * POST /api/admin/platform-scans/recommendations/[id]/remediate
 *
 * Close the loop: turn an accepted recommendation into a review-gated remediation
 * PR on the target repo. NEVER merges (the PR is the human checkpoint), runs the
 * OGIAM gate (decision recorded to the ledger), and records the PR URL back on
 * the recommendation. Read-against + propose-only: the agent opens a PR, a human
 * reviews and merges.
 *
 * Learning tie-in: the gate decision lands in the OGIAM ledger, the PR URL is
 * persisted on the recommendation, and the action emits analytics + a
 * hash-chained audit entry. No data lost.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { resolveScanTarget } from "@/lib/platform-scan/manifests";
import { getRecommendationById, setRecommendationPr } from "@/lib/platform-scan/recommend/store";
import { openRemediationPR } from "@/lib/platform-scan/recommend/remediation";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";
  const { id } = await ctx.params;

  const rec = await getRecommendationById(workspaceId, id);
  if (!rec) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (rec.prUrl) {
    return NextResponse.json({ ok: true, alreadyOpen: true, prUrl: rec.prUrl, recommendation: rec });
  }

  const manifest = await resolveScanTarget(workspaceId, rec.platform);
  if (!manifest?.static) {
    return NextResponse.json({ error: "no_repo_target" }, { status: 400 });
  }
  const repoFullName = `${manifest.static.owner}/${manifest.static.repo}`;
  const baseBranch = manifest.static.ref ?? "main";

  let result;
  try {
    result = await openRemediationPR({
      rec,
      repoFullName,
      baseBranch,
      workspaceId,
      actor: { userId: user.id, role: user.role },
    });
  } catch (err) {
    const msg = (err as Error).message;
    // A gate block is a deliberate 403; anything else is an upstream failure (502).
    const status = msg.startsWith("gate_blocked") ? 403 : 502;
    return NextResponse.json({ error: "remediation_failed", detail: msg }, { status });
  }

  const updated = await setRecommendationPr(workspaceId, id, result.prUrl, user.id);

  trackEvent("platform.remediation_pr_opened", user.id, user.role, {
    platform: rec.platform,
    key: rec.key,
    pr_url: result.prUrl,
    gate_outcome: result.decision.effectiveOutcome,
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.remediation_pr_opened",
    resourceType: "automation_recommendation",
    resourceId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { platform: rec.platform, key: rec.key, pr_url: result.prUrl, branch: result.branch },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({
    ok: true,
    prUrl: result.prUrl,
    prNumber: result.prNumber,
    branch: result.branch,
    recommendation: updated ?? rec,
  });
}
