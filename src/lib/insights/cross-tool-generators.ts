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

/* ── Helpers ──────────────────────────────────────────────────────── */

/** Bot authors create review noise (dependabot bumps, renovate, etc).
 *  Their PRs don't reflect human stagnation — exclude from signal. */
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

/** Email local-part = the bit before `@`, lowercased. Used as a
 *  loose join key between calendar attendees (email) and GitHub PR
 *  authors (login). Not perfect — but covers the common case where
 *  someone's GitHub handle matches their work-email prefix. */
function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return (at > 0 ? email.slice(0, at) : email).toLowerCase().trim();
}

/* ── Generator 1: GitHub PR stagnation (single-source, bot-filtered) ── */

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

/* ── Generator 2: Vercel × GitHub — failed deploys with no follow-up ─
 *
 * Upgrade over v1: now actually verifies that no later READY deploy
 * exists on the same `meta.githubCommitRef`. v1 listed every ERROR
 * even if the team already redeployed successfully — pure noise. */

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
      // Has a later READY deploy on the same branch already shipped? Skip.
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
        title: `${f.name}: failed ${f.target} deploy${ref ? ` on ${ref}` : ""}, no follow-up`,
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

/* ── Generator 3: Email × Calendar — unread email from upcoming attendee ─
 *
 * Strictly cross-tool. Finds unread emails from someone you have a
 * meeting with in the next 7 days. Severity = how soon the meeting is.
 *
 * No other tool sees this — Outlook surfaces unread, Calendar surfaces
 * upcoming, but the join (this unread is from someone you're about to
 * meet) is unique to Instinct. */

async function generateUnreadEmailFromMeetingAttendee(
  ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  try {
    const { fetchCalendarEvents, fetchRecentEmails, fetchUserProfile } =
      await import("@/lib/microsoft-graph");
    const now = new Date();
    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + 7);

    const [events, emails, me] = await Promise.all([
      fetchCalendarEvents(ctx.userId, now.toISOString(), horizon.toISOString()),
      fetchRecentEmails(ctx.userId, 25),
      fetchUserProfile(ctx.userId),
    ]);
    if (!events || events.length === 0) return [];
    if (!emails || emails.length === 0) return [];

    const myEmail = (me?.email ?? "").toLowerCase();

    // Map attendee email → soonest upcoming meeting with that person.
    const attendeeToMeeting = new Map<
      string,
      { event: (typeof events)[number]; startMs: number }
    >();
    for (const ev of events) {
      const startMs = new Date(ev.start).getTime();
      if (startMs < now.getTime()) continue; // past meetings don't count
      if (ev.showAs === "free") continue;
      for (const addr of ev.attendeeEmails ?? []) {
        const a = addr.toLowerCase();
        if (!a || a === myEmail) continue;
        const existing = attendeeToMeeting.get(a);
        if (!existing || startMs < existing.startMs) {
          attendeeToMeeting.set(a, { event: ev, startMs });
        }
      }
    }
    if (attendeeToMeeting.size === 0) return [];

    const insights: CrossToolInsight[] = [];
    const seenIds = new Set<string>();
    for (const em of emails) {
      if (em.isRead) continue;
      const from = (em.fromEmail ?? "").toLowerCase();
      const hit = attendeeToMeeting.get(from);
      if (!hit) continue;
      const hoursUntil =
        (hit.startMs - now.getTime()) / (60 * 60 * 1000);
      const severity: InsightSeverity =
        hoursUntil < 24 ? "high" : hoursUntil < 72 ? "medium" : "low";
      const signalStrength =
        em.importance === "high" ? 95 : Math.max(40, 100 - Math.round(hoursUntil));
      const id = `email_unread_meeting_attendee:${em.id}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const whenLabel =
        hoursUntil < 24
          ? "today"
          : hoursUntil < 48
            ? "tomorrow"
            : `in ${Math.round(hoursUntil / 24)} days`;
      insights.push({
        id,
        generator: "email_unread_from_meeting_attendee",
        severity,
        signalStrength,
        title: `Unread email from ${em.from} — you meet ${whenLabel}`,
        detail: `"${em.subject}". Meeting: ${hit.event.subject || "(no subject)"}.`,
        action: em.webLink
          ? { label: "Open email", href: em.webLink }
          : { label: "Open email" },
        sources: ["email", "calendar"],
      });
      if (insights.length >= 4) break;
    }
    return insights;
  } catch {
    return [];
  }
}

/* ── Generator 4: Calendar × GitHub — open PR from upcoming meeting attendee ─
 *
 * If you're meeting someone this week AND they have an open PR awaiting
 * your review, that's the kind of "right context before the conversation"
 * insight only the cross-tool view can produce.
 *
 * Match: GitHub PR author login (e.g. `hoxsie`) against attendee email
 * local-part (e.g. `hoxsie@thewolfpack.agency`). Fuzzy but reliable in
 * practice for org members. */

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

    // local-part → soonest meeting where they are an attendee.
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
        hoursUntil < 24 ? "high" : hoursUntil < 72 ? "medium" : "low";
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
        signalStrength:
          severity === "high" ? 95 : severity === "medium" ? 70 : 45,
        title: `${pr.user}'s ${pr.repo}#${pr.number} open — you meet ${whenLabel}`,
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

export const INSIGHT_GENERATORS: InsightGenerator[] = [
  {
    name: "github_pr_stagnation",
    label: "Open PRs with no activity for 7+ days (humans only)",
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
    name: "email_unread_from_meeting_attendee",
    label: "Unread email from someone you have an upcoming meeting with",
    requires: ["email", "calendar"],
    run: generateUnreadEmailFromMeetingAttendee,
  },
  {
    name: "meeting_attendee_open_pr",
    label: "Open PR by someone you have an upcoming meeting with",
    requires: ["github", "calendar"],
    run: generateMeetingAttendeeOpenPr,
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
