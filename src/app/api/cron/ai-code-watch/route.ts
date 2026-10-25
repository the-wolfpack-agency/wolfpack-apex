/**
 * GET /api/cron/ai-code-watch - the autonomous factory watcher (multi-tenant).
 *
 * Vercel Cron hits this on a short schedule; it reads every ENABLED (workspace,
 * repo) enrolled in the DB (watched-repos), plus an optional env bootstrap, and
 * drives each target's factory PRs one ci-fix step - each with that workspace's
 * OWN credentials and gated by that workspace's secure_agent entitlement. So one
 * deployment serves every client with no per-project env vars.
 *
 * Auth mirrors the other crons: `Authorization: Bearer ${CRON_SECRET}` for the
 * scheduler, capability fallback for a manual run. Returns: 200 { summary } | 401.
 *
 * Every PR is keyed by its CURRENT head SHA and checked against the watcher's
 * memory (migration 293) before it is driven: a terminal or exhausted SHA is
 * skipped, and so is a PR past its daily cap. See watch.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/auth/bearer-auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { workspaceGithubClient, listOpenPullRequests, getBranchHead, type GithubClient } from "@/lib/github-client";
import { resolveEntitlement } from "@/lib/tenancy/entitlements";
import { driveCiFixStep } from "@/lib/ai-code/ci-fix-runner";
import { listAllEnabledWatched, mergeWatchTargets } from "@/lib/ai-code/watched-repos";
import { runAiCodeWatch, dbWatchMemory, type WatchTarget } from "@/lib/ai-code/watch";
import { runWithRequestWorkspace } from "@/lib/db/request-workspace";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return isAuthorizedBearer(req.headers.get("authorization"), secret);
}

const SYSTEM_ACTOR = { userId: "system:ai-code-watch", role: "system" };

async function runWatch(): Promise<NextResponse> {
  // SaaS source of truth: every enabled (workspace, repo) in the DB, plus the env
  // bootstrap fallback (single-tenant convenience only).
  const dbTargets = await listAllEnabledWatched();
  const merged = mergeWatchTargets(dbTargets, process.env.AI_CODE_WATCH_REPOS, process.env.AI_CODE_WATCH_WORKSPACE);

  // Gate each workspace by its secure_agent entitlement (a client that is not
  // entitled is never driven), checked once per workspace.
  const entitledCache = new Map<string, boolean>();
  const targets: WatchTarget[] = [];
  for (const t of merged) {
    let ok = entitledCache.get(t.workspaceId);
    if (ok === undefined) {
      ok = await resolveEntitlement(t.workspaceId, "secure_agent");
      entitledCache.set(t.workspaceId, ok);
    }
    if (ok) targets.push(t);
  }

  // One GitHub client per workspace, reused across that workspace's repos.
  const clientCache = new Map<string, GithubClient>();
  const clientFor = async (workspaceId: string): Promise<GithubClient> => {
    let c = clientCache.get(workspaceId);
    if (!c) {
      c = await workspaceGithubClient(workspaceId || "default");
      clientCache.set(workspaceId, c);
    }
    return c;
  };

  // The work list is cross-workspace (listAllEnabledWatched); everything done
  // for a target runs under that target's workspace.
  const inTarget = <R>(t: WatchTarget, fn: () => Promise<R>): Promise<R> =>
    runWithRequestWorkspace(t.workspaceId || "default", fn);
  const summary = await runAiCodeWatch({
    targets,
    listPRs: (t) => inTarget(t, async () => listOpenPullRequests(await clientFor(t.workspaceId), t.repo)),
    resolveHead: (t, pr) => inTarget(t, async () => getBranchHead(await clientFor(t.workspaceId), t.repo, pr.headRef)),
    memory: dbWatchMemory(),
    drive: (t, pr) => inTarget(t, async () => {
      const { body } = await driveCiFixStep({
        repo: t.repo,
        ref: pr.headRef,
        branch: pr.headRef,
        base: pr.baseRef,
        prNumber: pr.number,
        attempt: 0,
        maxAttempts: 3,
        workspaceId: t.workspaceId || undefined,
        actor: SYSTEM_ACTOR,
      });
      const decision = (body.decision ?? {}) as { action?: string };
      return { action: decision.action, terminal: body.terminal as boolean | undefined };
    }),
  });
  return NextResponse.json({ summary });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) return runWatch();
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runWatch();
}
