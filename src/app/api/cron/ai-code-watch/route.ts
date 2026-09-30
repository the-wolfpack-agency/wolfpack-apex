/**
 * GET /api/cron/ai-code-watch - the autonomous factory watcher.
 *
 * Vercel Cron hits this on a short schedule; it drives every enrolled repo's
 * factory PRs one ci-fix step, so the factory watches ITSELF and a human is never
 * the poller. Auth mirrors the other crons: `Authorization: Bearer ${CRON_SECRET}`
 * for the scheduler, capability fallback for a manual run.
 *
 * Safety is in the watcher (watch.ts): opt-in repos only, factory/* PRs only, never
 * auto-merges, gated + audited. Returns: 200 { summary } | 401.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { workspaceGithubClient, listOpenPullRequests } from "@/lib/github-client";
import { driveCiFixStep } from "@/lib/ai-code/ci-fix-runner";
import { parseWatchRepos, runAiCodeWatch } from "@/lib/ai-code/watch";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

const SYSTEM_ACTOR = { userId: "system:ai-code-watch", role: "system" };

async function runWatch(): Promise<NextResponse> {
  const repos = parseWatchRepos(process.env.AI_CODE_WATCH_REPOS);
  const workspaceId = process.env.AI_CODE_WATCH_WORKSPACE || undefined;
  const client = await workspaceGithubClient(workspaceId ?? "default");
  const summary = await runAiCodeWatch({
    repos,
    listPRs: (repo) => listOpenPullRequests(client, repo),
    drive: async (repo, pr) => {
      const { body } = await driveCiFixStep({
        repo,
        ref: pr.headRef,
        branch: pr.headRef,
        base: pr.baseRef,
        attempt: 0,
        maxAttempts: 3,
        workspaceId,
        actor: SYSTEM_ACTOR,
      });
      const decision = (body.decision ?? {}) as { action?: string };
      return { action: decision.action, terminal: body.terminal as boolean | undefined };
    },
  });
  return NextResponse.json({ summary });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) return runWatch();
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runWatch();
}
