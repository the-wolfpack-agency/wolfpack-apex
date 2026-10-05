/**
 * POST /api/admin/ai-code/pulls/merge  { repo, prNumber }
 *
 * The in-tool "approve & merge" action: a human merges a factory PR from the
 * Code Factory surface. Governance is preserved, not bypassed:
 *   - Capability + entitlement gated, scoped to the caller's workspace credential.
 *   - SAFETY FLOOR: refuses to merge unless CI is green and readable (a manual
 *     approve may override the gate verdict / sensitivity, but never merges red or
 *     unverified CI).
 *   - GitHub's own branch protection (required checks + reviews) still applies to
 *     the merge call, so an unapproved / not-yet-green PR is refused BY GitHub and
 *     that reason is surfaced - the tool cannot merge what GitHub would not.
 * On success, records ai_code.pr_merged for the learning loop (source: tool).
 *
 * Returns: 200 { merged, sha } | 409 { error, status } (CI floor / GitHub refusal)
 *          | 400 (bad input) | 401/403 (auth/entitlement) | 503 (no credential)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { workspaceGithubClient, listOpenPullRequests, mergePullRequest } from "@/lib/github-client";
import { pullApprovalStatus } from "@/lib/ai-code/pull-approvals";
import { recordAuditNonFatal } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const body = (await req.json().catch(() => ({}))) as { repo?: unknown; prNumber?: unknown };
  const repo = String(body.repo ?? "").trim();
  const prNumber = Number(body.prNumber);
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: "repo and a positive integer prNumber are required" }, { status: 400 });
  }

  const workspaceId = resolveWorkspace(auth.user.workspaceId);
  const client = await workspaceGithubClient(workspaceId);
  if (!client.token) {
    return NextResponse.json({ error: "no GitHub credential for this workspace" }, { status: 503 });
  }

  // Resolve the PR's refs, and confirm it is an OPEN PR in this repo.
  const open = await listOpenPullRequests(client, repo);
  const pr = open.find((p) => p.number === prNumber);
  if (!pr) {
    return NextResponse.json({ error: `#${prNumber} is not an open PR in ${repo}` }, { status: 409 });
  }

  // Safety floor: never merge red or unverified CI, even on a manual approve.
  const status = await pullApprovalStatus(client, repo, pr, workspaceId);
  if (!status.ciReadable) {
    return NextResponse.json({ error: "CI could not be read; refusing to merge unverified", status }, { status: 409 });
  }
  if (!status.ciGreen) {
    return NextResponse.json({ error: "CI is not fully green; a human must not merge red CI", status }, { status: 409 });
  }

  const result = await mergePullRequest(client, repo, prNumber, { method: "squash" });
  if (!result.merged) {
    // Includes GitHub refusing the merge for branch protection (review/checks).
    return NextResponse.json({ error: result.reason, status }, { status: 409 });
  }

  // Merge is a security-relevant mutation: hash-chained audit entry + analytics.
  // recordAuditNonFatal: the merge already happened, so a telemetry failure must
  // never 500 a completed action (the ai-code route convention).
  await recordAuditNonFatal({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.pr_merged",
    resourceType: "pull_request",
    resourceId: `${repo}#${prNumber}`,
    afterState: { repo, prNumber, sha: result.mergedSha, source: "tool", workspaceId },
  });
  void trackEvent("ai_code.pr_merged", auth.user.id, auth.user.role, {
    repo,
    pr_number: prNumber,
    source: "tool",
    sha: result.mergedSha ?? "",
  });

  return NextResponse.json({ merged: true, sha: result.mergedSha });
}
