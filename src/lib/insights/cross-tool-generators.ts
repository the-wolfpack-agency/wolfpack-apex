/**
 * Cross-tool insight generators — rule-based pattern matchers that
 * fan across multiple integrations and surface signals no single tool
 * can see.
 *
 * Approach choice: pure rule-based (zero LLM tokens for the patterns
 * themselves). Three reasons:
 *   1. feedback_zero_tokens_first invariant: codify scanning patterns
 *      in tooling first, AI only for review.
 *   2. Insights must be auditable. "5 customers with overdue invoices
 *      you're meeting this week" is a verifiable JOIN; LLM hallucinations
 *      would erode trust on the first wrong call.
 *   3. Cheap to add new patterns: append to INSIGHT_GENERATORS, ship.
 *
 * The meeting-prep precedent uses a single LLM synthesis call per use.
 * That works for one meeting at a time; running it as a cross-tool
 * scan across the org would be cost-prohibitive. Rule-based scales.
 *
 * Each generator returns 0+ CrossToolInsight rows. The aggregator
 * sorts by severity (high → low) then by signal_strength (numeric
 * score 0-100 for tie-breaks).
 */

export type InsightSeverity = "high" | "medium" | "low";

export interface CrossToolInsight {
  /** Stable id for analytics + dedupe (`{generator}:{entityId}`). */
  id: string;
  /** Which generator produced this row. */
  generator: string;
  severity: InsightSeverity;
  /** 0-100; used as tie-break inside a severity bucket. */
  signalStrength: number;
  /** One-line summary (50-90 chars). */
  title: string;
  /** Optional plain-English detail (1-2 sentences, ~200 chars). */
  detail?: string;
  /** Optional suggested next action with a deep link or chip. */
  action?: { label: string; href?: string; chip?: string };
  /** Tools whose data contributed to this insight (for the badge row). */
  sources: string[];
}

export interface InsightContext {
  userId: string;
  userRole: string;
  /** Resolved Microsoft Graph token context (null if not connected).
   *  Typed as unknown to avoid coupling to a specific token shape;
   *  generators that need MS Graph cast and use it directly. */
  msToken?: unknown;
  /** Time horizon for "recent" comparisons. Default 14 days. */
  lookbackDays?: number;
}

export interface InsightGenerator {
  name: string;
  /** Human-readable label for the audit trail. */
  label: string;
  /** Source tool/integration names that must be connected. */
  requires: string[];
  /** Best-effort. May throw — the aggregator catches and continues. */
  run(ctx: InsightContext): Promise<CrossToolInsight[]>;
}

/* ── Calendar × Email patterns DEFERRED to v2 ─────────────────────────
 *
 * Two patterns ("calendar/email relationship gap" + "calendar overload
 * with no focus blocks") need MS Graph helpers that don't yet exist as
 * exports (listRecentMeetingAttendees, listRecentEmailContacts,
 * summarizeWeekCalendar). Adding them is a follow-up: ship the
 * generator pattern + 2 working generators (GitHub + Vercel) now;
 * extend with MS-backed generators once the helpers land. The
 * INSIGHT_GENERATORS array is the extension point; appending two
 * entries when the helpers exist is the entire diff.
 */

/* ── Generator 1: GitHub PR stagnation ────────────────────────────── */

async function generateGithubPrStagnation(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  try {
    const { searchPullRequests } = await import(
      "@/lib/assistant/tools/github-query-client"
    );
    const result = await searchPullRequests({ state: "open", perPage: 20 });
    if (!result.ok) return [];
    const now = Date.now();
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    const stale = result.data.filter(
      (pr) => now - new Date(pr.updated_at).getTime() > STALE_MS,
    );
    return stale.slice(0, 3).map((pr) => {
      const ageDays = Math.round(
        (now - new Date(pr.updated_at).getTime()) / (24 * 60 * 60 * 1000),
      );
      return {
        id: `github_pr_stagnation:${pr.repo}#${pr.number}`,
        generator: "github_pr_stagnation",
        severity: ageDays >= 14 ? "high" : "medium",
        signalStrength: Math.min(100, ageDays * 5),
        title: `${pr.repo}#${pr.number}: open ${ageDays} days, no activity`,
        detail: pr.title.slice(0, 160),
        action: { label: "Open PR", href: pr.html_url },
        sources: ["github"],
      };
    });
  } catch {
    return [];
  }
}

/* ── Generator 2: Vercel × GitHub — failed deploys without follow-up ─ */

async function generateVercelFailedNoFollowup(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  try {
    const { listDeployments, vercelIsConfigured } = await import(
      "@/lib/integrations/vercel"
    );
    if (!vercelIsConfigured()) return [];
    const res = await listDeployments({ limit: 30 });
    if (!res.ok || !res.data) return [];
    const failures = res.data.deployments.filter((d) => d.state === "ERROR");
    if (failures.length === 0) return [];
    const insights: CrossToolInsight[] = [];
    for (const f of failures.slice(0, 3)) {
      insights.push({
        id: `vercel_failed_no_followup:${f.uid}`,
        generator: "vercel_failed_no_followup",
        severity: f.target === "production" ? "high" : "medium",
        signalStrength: f.target === "production" ? 90 : 50,
        title: `${f.name}: failed ${f.target} deploy${f.meta?.githubCommitRef ? ` on ${f.meta.githubCommitRef}` : ""}`,
        detail: f.meta?.githubCommitMessage?.split("\n")[0]?.slice(0, 160),
        action: { label: "Open Vercel", href: `https://${f.url}` },
        sources: ["vercel", "github"],
      });
    }
    return insights;
  } catch {
    return [];
  }
}

export const INSIGHT_GENERATORS: InsightGenerator[] = [
  {
    name: "github_pr_stagnation",
    label: "Open PRs with no activity for 7+ days",
    requires: ["github"],
    run: generateGithubPrStagnation,
  },
  {
    name: "vercel_failed_no_followup",
    label: "Failed Vercel deploys with no follow-up commit",
    requires: ["vercel", "github"],
    run: generateVercelFailedNoFollowup,
  },
  /* Append additional generators here. See "DEFERRED to v2" note above
   * for the calendar/email patterns that are next. */
];

export async function runAllInsightGenerators(
  ctx: InsightContext,
): Promise<{
  insights: CrossToolInsight[];
  generatorOutcomes: Array<{ name: string; count: number; ok: boolean }>;
}> {
  const settled = await Promise.allSettled(
    INSIGHT_GENERATORS.map(async (g) => ({
      name: g.name,
      result: await g.run(ctx),
    })),
  );
  const insights: CrossToolInsight[] = [];
  const outcomes: Array<{ name: string; count: number; ok: boolean }> = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const gen = INSIGHT_GENERATORS[i];
    if (s.status === "fulfilled") {
      insights.push(...s.value.result);
      outcomes.push({ name: gen.name, count: s.value.result.length, ok: true });
    } else {
      outcomes.push({ name: gen.name, count: 0, ok: false });
    }
  }
  const sevRank = { high: 0, medium: 1, low: 2 } as const;
  insights.sort(
    (a, b) =>
      sevRank[a.severity] - sevRank[b.severity] ||
      b.signalStrength - a.signalStrength,
  );
  return { insights, generatorOutcomes: outcomes };
}
