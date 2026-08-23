/**
 * Cross-tool insight generators — rule-based pattern matchers that
 * fan across multiple integrations and surface signals no single tool
 * can see.
 *
 * DESIGN PRINCIPLE: insights are HELPFUL, not punishing. We never
 * surface "you didn't read X" or "you missed Y". Instead we surface
 * the kind of context that helps the user *do* their next thing —
 * "PR ready to discuss in your meeting", "momentum this week",
 * "heads-up that this deploy author is on your calendar".
 *
 * Approach: pure rule-based (zero LLM tokens for the patterns
 * themselves). Three reasons:
 *   1. feedback_zero_tokens_first invariant: codify scanning patterns
 *      in tooling first, AI only for review.
 *   2. Insights must be auditable. "Team merged 12 PRs this week" is
 *      a verifiable count; LLM hallucinations would erode trust.
 *   3. Cheap to add new patterns: append to INSIGHT_GENERATORS, ship.
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
  /** One-line summary (50-90 chars). HELPFUL framing, not accusatory. */
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

/* ── Helpers ──────────────────────────────────────────────────────── */

function isBotAuthor(login: string): boolean {
  const l = login.toLowerCase();
  return (
    l.endsWith("[bot]") ||
    l === "dependabot" ||
    l === "renovate" ||
    l === "github-actions" ||
    l.includes("-bot")
  );
}

function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return (at > 0 ? email.slice(0, at) : email).toLowerCase().trim();
}

/* ── Generator 1: GitHub PR awaiting review ───────────────────────── */

async function generateGithubPrStagnation(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  try {
    const { searchPullRequests } = await import(
      "@/lib/assistant/tools/github-query-client"
    );
    const result = await searchPullRequests({ state: "open", perPage: 25 });
    if (!result.ok) return [];
    const now = Date.now();
    const STALE_MS = 7 * 24 * 60 * 60 * 1000;
    const stale = result.data
      .filter((pr) => !isBotAuthor(pr.user))
      .filter((pr) => !pr.draft)
      .filter((pr) => now - new Date(pr.updated_at).getTime() > STALE_MS);
    return stale.slice(0, 3).map((pr) => {
      const ageDays = Math.round(
        (now - new Date(pr.updated_at).getTime()) / (24 * 60 * 60 * 1000),
      );
      return {
        id: `github_pr_stagnation:${pr.repo}#${pr.number}`,
        generator: "github_pr_stagnation",
        severity: ageDays >= 14 ? "medium" : "low",
        signalStrength: Math.min(100, ageDays * 5),
        title: `${pr.repo}#${pr.number} awaiting review for ${ageDays} days`,
        detail: pr.title.slice(0, 160),
        action: { label: "Open PR", href: pr.html_url },
        sources: ["github"],
      };
    });
  } catch {
    return [];
  }
}

/* ── Generator 2: Vercel × GitHub — failed deploys still needing follow-up ─ */

async function generateVercelFailedNoFollowup(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  try {
    const { listDeployments, vercelIsConfigured } = await import(
      "@/lib/integrations/vercel"
    );
    if (!vercelIsConfigured()) return [];
    const res = await listDeployments({ limit: 50 });
    if (!res.ok || !res.data) return [];
    const deployments = res.data.deployments;
    const failures = deployments.filter((d) => d.state === "ERROR");
    if (failures.length === 0) return [];

    const insights: CrossToolInsight[] = [];
    for (const f of failures) {
      const ref = f.meta?.githubCommitRef;
      const followedUp = deployments.some(
        (d) =>
          d.state === "READY" &&
          d.target === f.target &&
          d.meta?.githubCommitRef === ref &&
          d.createdAt > f.createdAt,
      );
      if (followedUp) continue;
      insights.push({
        id: `vercel_failed_no_followup:${f.uid}`,
        generator: "vercel_failed_no_followup",
        severity: f.target === "production" ? "high" : "medium",
        signalStrength: f.target === "production" ? 90 : 50,
        title: `${f.name}: ${f.target} deploy needs a follow-up${ref ? ` on ${ref}` : ""}`,
        detail: f.meta?.githubCommitMessage?.split("\n")[0]?.slice(0, 160),
        action: { label: "Open Vercel", href: `https://${f.url}` },
        sources: ["vercel", "github"],
      });
      if (insights.length >= 3) break;
    }
    return insights;
  } catch {
    return [];
  }
}

/* ── Generator 3: Calendar × GitHub — PR ready to discuss in upcoming meeting ─
 *
 * Helpful framing: "Heads-up — @alice has an open PR ready to discuss
 * in your meeting tomorrow." Not "you haven't reviewed it." */

async function generateMeetingAttendeeOpenPr(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  try {
    const [{ fetchCalendarEvents, fetchUserProfile }, { searchPullRequests }] =
      await Promise.all([
        import("@/lib/microsoft-graph"),
        import("@/lib/assistant/tools/github-query-client"),
      ]);

    const now = new Date();
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 7);
    const [events, me] = await Promise.all([
      fetchCalendarEvents(ctx.userId, now.toISOString(), horizon.toISOString()),
      fetchUserProfile(ctx.userId),
    ]);
    if (!events || events.length === 0) return [];

    const myEmail = (me?.email ?? "").toLowerCase();
    const myLocal = emailLocalPart(myEmail);

    const localToMeeting = new Map<
      string,
      { event: (typeof events)[number]; startMs: number }
    >();
    for (const ev of events) {
      const startMs = new Date(ev.start).getTime();
      if (startMs < now.getTime()) continue;
      if (ev.showAs === "free") continue;
      for (const addr of ev.attendeeEmails ?? []) {
        const local = emailLocalPart(addr);
        if (!local || local === myLocal) continue;
        const existing = localToMeeting.get(local);
        if (!existing || startMs < existing.startMs) {
          localToMeeting.set(local, { event: ev, startMs });
        }
      }
    }
    if (localToMeeting.size === 0) return [];

    const prs = await searchPullRequests({ state: "open", perPage: 25 });
    if (!prs.ok || prs.data.length === 0) return [];

    const insights: CrossToolInsight[] = [];
    for (const pr of prs.data) {
      if (isBotAuthor(pr.user)) continue;
      if (pr.draft) continue;
      const hit = localToMeeting.get(pr.user.toLowerCase());
      if (!hit) continue;
      const hoursUntil =
        (hit.startMs - now.getTime()) / (60 * 60 * 1000);
      const severity: InsightSeverity =
        hoursUntil < 24 ? "medium" : "low";
      const whenLabel =
        hoursUntil < 24
          ? "today"
          : hoursUntil < 48
            ? "tomorrow"
            : `in ${Math.round(hoursUntil / 24)} days`;
      insights.push({
        id: `meeting_attendee_open_pr:${pr.repo}#${pr.number}`,
        generator: "meeting_attendee_open_pr",
        severity,
        signalStrength: severity === "medium" ? 80 : 55,
        title: `Heads-up: @${pr.user}'s ${pr.repo}#${pr.number} could be discussed ${whenLabel}`,
        detail: pr.title.slice(0, 160),
        action: { label: "Open PR", href: pr.html_url },
        sources: ["github", "calendar"],
      });
      if (insights.length >= 4) break;
    }
    return insights;
  } catch {
    return [];
  }
}

/* ── Generator 4: Vercel × Calendar — recent deploy by upcoming attendee ─
 *
 * Vercel exposes `creator.username` on each deployment (the person
 * who triggered it). If that username matches the local-part of a
 * calendar attendee for an upcoming meeting, surface as helpful
 * coordination context. "Recent deploy by @alice — she's on your
 * 2pm." Not blame, just useful situational awareness. */

async function generateRecentDeployByMeetingAttendee(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  try {
    const [{ fetchCalendarEvents, fetchUserProfile }, vercel] =
      await Promise.all([
        import("@/lib/microsoft-graph"),
        import("@/lib/integrations/vercel"),
      ]);
    if (!vercel.vercelIsConfigured()) return [];

    const now = new Date();
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 2); // next 48h only
    const [events, me, deployRes] = await Promise.all([
      fetchCalendarEvents(ctx.userId, now.toISOString(), horizon.toISOString()),
      fetchUserProfile(ctx.userId),
      vercel.listDeployments({ limit: 25 }),
    ]);
    if (!events || events.length === 0) return [];
    if (!deployRes.ok || !deployRes.data) return [];

    const myLocal = emailLocalPart((me?.email ?? "").toLowerCase());
    const localToMeeting = new Map<
      string,
      { event: (typeof events)[number]; startMs: number }
    >();
    for (const ev of events) {
      const startMs = new Date(ev.start).getTime();
      if (startMs < now.getTime()) continue;
      if (ev.showAs === "free") continue;
      for (const addr of ev.attendeeEmails ?? []) {
        const local = emailLocalPart(addr);
        if (!local || local === myLocal) continue;
        const existing = localToMeeting.get(local);
        if (!existing || startMs < existing.startMs) {
          localToMeeting.set(local, { event: ev, startMs });
        }
      }
    }
    if (localToMeeting.size === 0) return [];

    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const recentDeploys = deployRes.data.deployments.filter(
      (d) => Date.now() - d.createdAt < SIX_HOURS_MS,
    );
    if (recentDeploys.length === 0) return [];

    const insights: CrossToolInsight[] = [];
    const seen = new Set<string>();
    for (const d of recentDeploys) {
      const username = d.creator?.username?.toLowerCase();
      if (!username) continue;
      const hit = localToMeeting.get(username);
      if (!hit) continue;
      if (seen.has(username)) continue;
      seen.add(username);
      const hoursUntil = (hit.startMs - Date.now()) / (60 * 60 * 1000);
      const whenLabel =
        hoursUntil < 24
          ? "today"
          : hoursUntil < 48
            ? "tomorrow"
            : `in ${Math.round(hoursUntil / 24)} days`;
      insights.push({
        id: `recent_deploy_by_meeting_attendee:${d.uid}`,
        generator: "recent_deploy_by_meeting_attendee",
        severity: "low",
        signalStrength: d.state === "ERROR" ? 70 : 50,
        title: `Heads-up: @${username} just ${d.state === "ERROR" ? "had a failed" : "shipped a"} ${d.target ?? "preview"} deploy — you meet ${whenLabel}`,
        detail: d.meta?.githubCommitMessage?.split("\n")[0]?.slice(0, 160),
        action: { label: "Open Vercel", href: `https://${d.url}` },
        sources: ["vercel", "calendar"],
      });
      if (insights.length >= 3) break;
    }
    return insights;
  } catch {
    return [];
  }
}

/* ── Generator 5: GitHub × Vercel — weekly team momentum ──────────────
 *
 * Positive cross-tool signal: this week the team merged N PRs across
 * M repos and shipped K successful prod deploys. No single tool gives
 * the combined view. Always low severity — informational. */

async function generateTeamMomentumBrief(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  try {
    const [{ searchPullRequests }, vercel] = await Promise.all([
      import("@/lib/assistant/tools/github-query-client"),
      import("@/lib/integrations/vercel"),
    ]);

    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - WEEK_MS;

    const [prRes, deployRes] = await Promise.all([
      searchPullRequests({ state: "closed", perPage: 25 }),
      vercel.vercelIsConfigured()
        ? vercel.listDeployments({ limit: 50 })
        : Promise.resolve({ ok: false } as const),
    ]);

    const mergedPrs = prRes.ok
      ? prRes.data.filter(
          (pr) =>
            !isBotAuthor(pr.user) &&
            new Date(pr.updated_at).getTime() >= cutoff,
        )
      : [];
    const repos = new Set(mergedPrs.map((pr) => pr.repo));

    const prodSuccessDeploys =
      deployRes.ok && deployRes.data
        ? deployRes.data.deployments.filter(
            (d) =>
              d.state === "READY" &&
              d.target === "production" &&
              d.createdAt >= cutoff,
          )
        : [];

    // Only emit if we have non-zero combined signal — otherwise it's noise.
    if (mergedPrs.length === 0 && prodSuccessDeploys.length === 0) return [];

    const sources: string[] = [];
    if (mergedPrs.length > 0) sources.push("github");
    if (prodSuccessDeploys.length > 0) sources.push("vercel");

    const parts: string[] = [];
    if (mergedPrs.length > 0) {
      parts.push(
        `${mergedPrs.length} PR${mergedPrs.length === 1 ? "" : "s"} merged across ${repos.size} repo${repos.size === 1 ? "" : "s"}`,
      );
    }
    if (prodSuccessDeploys.length > 0) {
      const projects = new Set(prodSuccessDeploys.map((d) => d.name));
      parts.push(
        `${prodSuccessDeploys.length} prod deploy${prodSuccessDeploys.length === 1 ? "" : "s"} shipped across ${projects.size} project${projects.size === 1 ? "" : "s"}`,
      );
    }

    return [
      {
        id: `team_momentum_brief:${new Date().toISOString().slice(0, 10)}`,
        generator: "team_momentum_brief",
        severity: "low",
        signalStrength: 30, // informational, lives below action-required items
        title: `This week: ${parts.join("; ")}`,
        detail: "Combined view across GitHub and Vercel for the last 7 days.",
        sources,
      },
    ];
  } catch {
    return [];
  }
}

export const INSIGHT_GENERATORS: InsightGenerator[] = [
  {
    name: "github_pr_stagnation",
    label: "Open PRs awaiting review for 7+ days (humans only)",
    requires: ["github"],
    run: generateGithubPrStagnation,
  },
  {
    name: "vercel_failed_no_followup",
    label: "Failed Vercel deploys with no successful redeploy on same branch",
    requires: ["vercel", "github"],
    run: generateVercelFailedNoFollowup,
  },
  {
    name: "meeting_attendee_open_pr",
    label: "Open PR by someone on your upcoming meeting calendar",
    requires: ["github", "calendar"],
    run: generateMeetingAttendeeOpenPr,
  },
  {
    name: "recent_deploy_by_meeting_attendee",
    label: "Recent Vercel deploy by an upcoming-meeting attendee (coordination heads-up)",
    requires: ["vercel", "calendar"],
    run: generateRecentDeployByMeetingAttendee,
  },
  /* The two below are the only generators here that say something on
     the day a client connects, rather than after a month of use. See
     source-topology.ts for why that distinction is the product. */
  /* Read the client's own database counters. These are the only
     generators that see load we did not cause. */
  {
    name: "legacy_cold_tables",
    label: "Large tables in the client database that nothing reads",
    requires: ["legacy-database"],
    run: (ctx) => import("./legacy-db-insights").then((m) => m.generateColdTables(ctx)),
  },
  {
    name: "legacy_read_concentration",
    label: "Which few tables carry most of the client database's reads",
    requires: ["legacy-database"],
    run: (ctx) => import("./legacy-db-insights").then((m) => m.generateReadConcentration(ctx)),
  },
  {
    name: "repeated_query_shapes",
    label: "One statement repeated enough for the total to matter",
    requires: ["legacy-database"],
    run: (ctx) => import("./legacy-db-insights").then((m) => m.generateRepeatedQueryShapes(ctx)),
  },
  {
    name: "cross_source_overlap",
    label: "The same entity class held in more than one connected system",
    requires: ["connectors"],
    run: (ctx) =>
      import("./source-topology").then((m) => m.generateCrossSourceOverlap(ctx)),
  },
  {
    name: "redundant_source_reads",
    label: "One system answering the identical request repeatedly in a short window",
    requires: ["connectors"],
    run: (ctx) =>
      import("./source-topology").then((m) => m.generateRedundantSourceReads(ctx)),
  },
  {
    name: "team_momentum_brief",
    label: "This week's team momentum (merged PRs + successful prod deploys)",
    requires: ["github", "vercel"],
    run: generateTeamMomentumBrief,
  },
  /* Append additional generators here. */
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
