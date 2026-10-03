/**
 * /api/admin/ai-code/watched-repos - manage the autonomous watcher's enrolled
 * repos for THIS workspace (SaaS config in the DB, not env vars). The cron reads
 * these across all workspaces and drives each with its own credentials.
 *
 *   GET                       -> { repos }        list this workspace's enrollments
 *   POST   { repo, enabled? } -> { ok }           enroll (or pause/resume) a repo
 *   DELETE ?repo=owner/name   -> { ok }           remove a repo
 *
 * Capability + secure_agent entitlement gated. Mutations write the hash-chained
 * audit log. Returns 200 | 400 | 401/403.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { recordAuditNonFatal } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { listWatchedRepos, enrollRepo, setRepoEnabled, unenrollRepo, isValidRepo } from "@/lib/ai-code/watched-repos";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;
  const repos = await listWatchedRepos(auth.user.workspaceId);
  return NextResponse.json({ repos });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let b: { repo?: unknown; enabled?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  if (!isValidRepo(repo)) return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  const enabled = b.enabled === undefined ? true : b.enabled === true;

  const ws = auth.user.workspaceId;
  if (enabled) await enrollRepo(ws, repo);
  else await setRepoEnabled(ws, repo, false);

  await recordAuditNonFatal({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.watched_repo_set",
    resourceType: "ai_code_watched_repo",
    resourceId: `${ws}:${repo}`,
    afterState: { repo, enabled },
  });
  trackEvent("ai_code.watched_repo_set", auth.user.id, auth.user.role, { workspace_id: ws, repo, enabled });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const repo = (new URL(req.url).searchParams.get("repo") ?? "").trim();
  if (!isValidRepo(repo)) return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });

  const ws = auth.user.workspaceId;
  await unenrollRepo(ws, repo);
  await recordAuditNonFatal({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.watched_repo_removed",
    resourceType: "ai_code_watched_repo",
    resourceId: `${ws}:${repo}`,
  });
  trackEvent("ai_code.watched_repo_set", auth.user.id, auth.user.role, { workspace_id: ws, repo, enabled: false });
  return NextResponse.json({ ok: true });
}
