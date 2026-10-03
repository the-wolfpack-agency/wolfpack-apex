/**
 * POST /api/admin/ai-code/revert  { repo, branch, toSha, trigger? }
 *
 * Revert a factory PR branch to a known-good checkpoint. Backs the manual
 * "revert last change" button and the auto-revert-after-failed-canary path.
 *
 * Safety (see ai-code/revert.ts): only ever resets a factory-created branch
 * (never a human branch / release / main), through the tenant's OWN GitHub
 * client (never ours), governed by the OGIAM gate + hash-chained ledger.
 *
 * Capability + secure_agent entitlement gated.
 * Returns: 200 { ok, branch, revertedTo, from } | 200 { ok:false, reason } | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { recordAuditNonFatal, extractRequestMetadata } from "@/lib/audit-log";
import { workspaceGithubClient } from "@/lib/github-client";
import { revertFactoryBranch } from "@/lib/ai-code/revert";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let b: { repo?: unknown; branch?: unknown; toSha?: unknown; trigger?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  const branch = typeof b.branch === "string" ? b.branch.trim() : "";
  const toSha = typeof b.toSha === "string" ? b.toSha.trim() : "";
  const trigger = b.trigger === "canary_auto" ? "canary_auto" : "manual";
  if (!repo || !branch || !toSha) {
    return NextResponse.json({ error: "repo, branch, and toSha are required" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }

  const workspaceId = resolveWorkspace(auth.user.workspaceId);
  const client = await workspaceGithubClient(workspaceId);
  if (!client.token) {
    return NextResponse.json({ ok: false, reason: "no GitHub token for this workspace; cannot revert" });
  }

  const outcome = await revertFactoryBranch({
    client,
    repoFullName: repo,
    branch,
    toSha,
    workspaceId,
    userId: auth.user.id,
    userRole: auth.user.role,
    trigger,
  });

  // Rewriting a branch is a security-relevant mutation on the client's repo, so
  // it lands on the hash-chained audit log in addition to the OGIAM action ledger.
  const meta = extractRequestMetadata(req);
  await recordAuditNonFatal({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.branch_reverted",
    resourceType: "github_branch",
    resourceId: `${repo}#${branch}`,
    beforeState: outcome.ok ? { head: outcome.from } : undefined,
    afterState: outcome.ok ? { head: outcome.revertedTo, trigger } : { failed: outcome.reason, trigger },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  });

  return NextResponse.json(outcome);
}
