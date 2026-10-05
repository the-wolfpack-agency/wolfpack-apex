/**
 * GET /api/admin/ai-code/pulls?repo=<owner/name>
 *
 * The read model for the Code Factory's in-tool approval surface: the workspace's
 * OPEN factory PRs, each with its link, CI-green state, gate verdict, and whether
 * it meets the auto-merge eligibility policy. Read-only. Capability + entitlement
 * gated, scoped to the caller's workspace credential.
 *
 * Returns: 200 { pulls } | 400 (missing repo) | 401/403 (auth/entitlement)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { workspaceGithubClient } from "@/lib/github-client";
import { listFactoryPullStatuses } from "@/lib/ai-code/pull-approvals";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const repo = (new URL(req.url).searchParams.get("repo") ?? "").trim();
  if (!repo) return NextResponse.json({ error: "repo is required" }, { status: 400 });

  const workspaceId = resolveWorkspace(auth.user.workspaceId);
  const client = await workspaceGithubClient(workspaceId);
  if (!client.token) {
    return NextResponse.json({ pulls: [], note: "no GitHub credential for this workspace" });
  }
  const pulls = await listFactoryPullStatuses(client, repo, workspaceId);
  return NextResponse.json({ pulls });
}
