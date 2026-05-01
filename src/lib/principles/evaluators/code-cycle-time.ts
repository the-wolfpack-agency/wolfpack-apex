/**
 * Real evaluator for `code.pr_cycle_time_under`.
 *
 * Queries the GitHub API for closed (merged) pull requests in the
 * configured org/repo over the evaluation window and emits one
 * observation per PR. Score is +0.5 (adherence) when cycle time
 * (created → merged) is under the threshold (default 48h), -0.5
 * otherwise.
 *
 * Like the goals evaluator, this is a team-wide signal — PR cycle
 * time isn't per-member-scoped. We emit observations with
 * `subjectUserId = ctx.subjectUserId` so each user's per-member
 * view sees the same team PR signal alongside their personal
 * mail/calendar/tasks rows.
 *
 * Auth: uses the existing GH_PAT env var (already set on the repo).
 * If unset or rate-limited, returns [] gracefully.
 */

import type {
  EvaluationContext,
  Observation,
} from "@/lib/principles/validators";

const DEFAULT_THRESHOLD_HOURS = 48;

interface PrSummary {
  number: number;
  html_url: string;
  title: string;
  created_at: string;
  merged_at: string | null;
  closed_at: string | null;
}

function envRepoSlug(): string | null {
  /* Expected format: <owner>/<repo>. Defaults to the wolfpack-instinct
     repo since that's where most of our PRs live. */
  return (
    process.env.PRINCIPLES_CODE_REPO ||
    "the-wolfpack-agency/wolfpack-apex"
  );
}

export async function evaluateCodeCycleTime(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  const userId = ctx.subjectUserId;
  if (!userId) return [];
  const repoSlug = envRepoSlug();
  if (!repoSlug) return [];
  const token = process.env.GH_PAT;
  if (!token) return [];

  /* GitHub's /pulls endpoint pages by 'state'. Fetch closed PRs +
     filter by merge in window. Cap top page so the cron doesn't
     spend a long time. */
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${repoSlug}/pulls?state=closed&per_page=50&sort=updated&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const prs = (await res.json().catch(() => [])) as PrSummary[];
  if (!Array.isArray(prs)) return [];

  const startMs = Date.parse(ctx.windowStart);
  const endMs = Date.parse(ctx.windowEnd);
  const observations: Observation[] = [];
  for (const pr of prs) {
    if (!pr.merged_at) continue;
    const mergedMs = Date.parse(pr.merged_at);
    if (!Number.isFinite(mergedMs)) continue;
    if (mergedMs < startMs || mergedMs > endMs) continue;
    const createdMs = Date.parse(pr.created_at);
    if (!Number.isFinite(createdMs)) continue;
    const cycleHours = (mergedMs - createdMs) / (60 * 60 * 1000);
    const score = cycleHours <= DEFAULT_THRESHOLD_HOURS ? 0.5 : -0.5;
    observations.push({
      surface: "code",
      surfaceSubtype: "pr_cycle_time",
      subjectUserId: userId,
      observedAt: pr.merged_at,
      score,
      evidence: {
        kind: "pr_cycle_time",
        sourceId: String(pr.number),
        sourceUrl: pr.html_url,
        notes: pr.title?.slice(0, 200),
        metric: {
          name: "cycle_hours",
          value: Number(cycleHours.toFixed(2)),
        },
      },
    });
  }
  return observations;
}
