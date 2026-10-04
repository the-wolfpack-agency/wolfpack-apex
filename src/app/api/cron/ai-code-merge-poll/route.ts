/**
 * GET /api/cron/ai-code-merge-poll - completes the factory's mission telemetry.
 *
 * ai_code.pr_opened says a reviewable PR was produced. This poll checks whether a
 * human MERGED it (the real win) or CLOSED it unmerged, and emits
 * ai_code.pr_merged / ai_code.pr_closed_unmerged exactly once per PR. That turns
 * "the gate ran" into "did the work actually land" - the outcome, not the lock.
 *
 * Auth mirrors the other crons: Authorization: Bearer ${CRON_SECRET}, with a
 * manage-team capability fallback for a manual run. The decision core
 * (pollMergeOutcomes / classifyOutcomes) is pure + unit-tested; this route is
 * only the IO wiring. Never throws: a single PR read failure skips that PR.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedBearer } from "@/lib/auth/bearer-auth";
import { requireCapability } from "@/lib/auth/require-capability";
import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { workspaceGithubClient, getPullRequest } from "@/lib/github-client";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { pollMergeOutcomes, type OpenedPr, type PrState } from "@/lib/ai-code/merge-poll";
import { reinforceFromOutcome } from "@/lib/ai-code/factory-reinforce";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && isAuthorizedBearer(req.headers.get("authorization"), secret);
}

type Meta = { repo?: unknown; pr_number?: unknown; approval_id?: unknown };
const asOpened = (m: Meta): OpenedPr | null => {
  const repo = typeof m.repo === "string" ? m.repo : null;
  const n = typeof m.pr_number === "number" ? m.pr_number : Number(m.pr_number);
  const approvalId = typeof m.approval_id === "string" ? m.approval_id : undefined;
  return repo && Number.isInteger(n) && n > 0 ? { repo, prNumber: n, approvalId } : null;
};

async function run(): Promise<NextResponse> {
  if (!process.env.DATABASE_URL) return NextResponse.json({ ok: true, polled: 0, outcomes: [], note: "no database" });

  // The factory's GitHub client (single-tenant default; multi-tenant deferred with
  // the SaaS cutover - pr_opened does not carry a workspace today).
  const client = await workspaceGithubClient(resolveWorkspace(null));

  const outcomes = await pollMergeOutcomes({
    loadOpenedPrs: async () => {
      const { rows } = await query<{ metadata: Meta }>(
        `SELECT metadata FROM instinct_events
          WHERE event_type = 'ai_code.pr_opened' AND timestamp > now() - interval '45 days'`,
      );
      return rows.map((r) => asOpened(r.metadata)).filter((o): o is OpenedPr => o !== null);
    },
    loadAlreadyReported: async () => {
      const { rows } = await query<{ metadata: Meta }>(
        `SELECT metadata FROM instinct_events
          WHERE event_type IN ('ai_code.pr_merged', 'ai_code.pr_closed_unmerged')`,
      );
      const seen = new Set<string>();
      for (const r of rows) { const o = asOpened(r.metadata); if (o) seen.add(`${o.repo}#${o.prNumber}`); }
      return seen;
    },
    prState: async (repo, prNumber): Promise<PrState | null> => {
      if (!client.token) return null;
      const pr = await getPullRequest(client, repo, prNumber);
      return { merged: pr.merged, closedUnmerged: pr.state === "closed" && !pr.merged };
    },
    emit: async (event, repo, prNumber) => {
      await trackEvent(event, "system", "system", { repo, pr_number: prNumber });
    },
    // Close the learning loop: a merged PR reinforces the memories its run used;
    // a closed-unmerged one decays them (weight-aware retrieval reads the result).
    reinforce: async (o) => {
      await reinforceFromOutcome({
        workspaceId: resolveWorkspace(null),
        repo: o.repo,
        approvalId: o.approvalId,
        merged: o.event === "ai_code.pr_merged",
      });
    },
  });

  return NextResponse.json({ ok: true, outcomes: outcomes.length, detail: outcomes });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) {
    const auth = await requireCapability(req, "settings.manage_team");
    if (!auth.ok) return auth.response;
  }
  return run();
}
