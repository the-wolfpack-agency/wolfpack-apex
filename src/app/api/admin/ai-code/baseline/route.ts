/**
 * /api/admin/ai-code/baseline
 *
 *   GET  ?repo=<owner/name>  -> the stored baseline for the repo (or null).
 *   POST { repo }            -> capture the repo's CURRENT default-branch check
 *                               state as its baseline (upsert). "Baseline before
 *                               testing", so pre-existing failures are recorded
 *                               up front and never blamed on the factory.
 *
 * Capability + secure_agent entitlement gated. POST is audited (hash chain).
 * Never 500s on an unreachable repo: it returns ok:false with the reason.
 * Returns: 200 { baseline } (GET) | 200 { ok, ... } (POST) | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { workspaceGithubClient, fetchRepoInfo, listCheckRuns } from "@/lib/github-client";
import { saveRepoBaseline, getRepoBaseline } from "@/lib/ai-code/baseline-store";

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const repo = (new URL(req.url).searchParams.get("repo") ?? "").trim();
  if (!repo || !REPO_RE.test(repo)) return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });

  const baseline = await getRepoBaseline(auth.user.workspaceId ?? "default", repo);
  return NextResponse.json({ baseline });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let b: { repo?: unknown };
  try {
    b = (await req.json()) as { repo?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  if (!repo || !REPO_RE.test(repo)) return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });

  const workspaceId = auth.user.workspaceId ?? "default";
  const client = await workspaceGithubClient(workspaceId);
  if (!client.token) {
    return NextResponse.json({ ok: false, reason: "no GitHub credential for this workspace; cannot baseline the repo" });
  }

  let defaultBranch: string | null = null;
  let checks: Awaited<ReturnType<typeof listCheckRuns>> = [];
  try {
    const info = await fetchRepoInfo(client, repo);
    defaultBranch = info.defaultBranch;
    checks = await listCheckRuns(client, repo, info.defaultBranch);
  } catch {
    return NextResponse.json({ ok: false, reason: "the repository could not be read; confirm the App is installed on it" });
  }

  const summary = await saveRepoBaseline({ workspaceId, repo, defaultBranch, checks, capturedBy: auth.user.id });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.baseline_captured",
    resourceType: "github_repo",
    resourceId: repo,
    afterState: { defaultBranch, totalCount: summary.totalCount, failingCount: summary.failingCount },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, repo, defaultBranch, ...summary });
}
