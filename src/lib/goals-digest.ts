/**
 * Goals weekly digest — shared build + deliver helpers used by
 * `/api/jobs/goals-digest`.
 *
 * buildGoalsDigest() composes a plain-language summary for ONE user for
 * ONE week:
 *   - Team north-star value + pct change vs previous snapshot
 *   - Last week: hit/miss counts from the user's graded contributions
 *   - This week: how many commitments are still pending team-wide
 *
 * deliverGoalsDigest() fans out the payload via the chosen channel:
 *   - "resend"   → email via Resend REST (no SDK dep)
 *   - "teams"    → Teams webhook (simple adaptive card)
 *   - "queue"    → INSERT into instinct_digest_queue for later delivery
 *
 * Channel selection is `resolveDigestChannel()` — reads RESEND_API_KEY /
 * TEAMS_WEBHOOK_URL at call time so tests can stub the env.
 *
 * Zero new runtime deps — uses global fetch + existing `safeQuery`.
 */

import { safeQuery } from "@/lib/db";
import { getWeeklyCommitments, getTeamCommitmentsForWeek } from "@/lib/goals-contributions";
import { getNorthStarTrend } from "@/lib/goals-north-star";

export type GoalsDigestChannel = "resend" | "teams" | "queue";

export interface DigestRecipient {
  user_id: string;
  email: string;
  role: string;
  name: string;
}

export interface GoalsDigestPayload {
  user_id: string;
  week_of: string;
  hit_count: number;
  miss_count: number;
  close_count: number;
  pending_count: number;
  // Non-null when we have at least one snapshot.
  north_star: {
    label: string;
    value: number;
    unit: string | null;
    pct_change: number | null;
  } | null;
  // Short human-readable lines for the email body / card.
  summary_lines: string[];
}

// ---------------------------------------------------------------------------
// Channel resolution
// ---------------------------------------------------------------------------

export function resolveDigestChannel(): GoalsDigestChannel {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.TEAMS_WEBHOOK_URL) return "teams";
  return "queue";
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function previousWeek(week_of: string): string {
  const d = new Date(`${week_of}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

export async function buildGoalsDigest(opts: {
  user_id: string;
  week_of: string;
}): Promise<GoalsDigestPayload> {
  const lastWeek = previousWeek(opts.week_of);

  const [thisWeekUser, lastWeekUser, teamThisWeek, northStarTrend] = await Promise.all([
    getWeeklyCommitments({ user_id: opts.user_id, week_of: opts.week_of }),
    getWeeklyCommitments({ user_id: opts.user_id, week_of: lastWeek }),
    getTeamCommitmentsForWeek(opts.week_of),
    getNorthStarTrend({ limit: 2 }),
  ]);

  let hit_count = 0;
  let miss_count = 0;
  let close_count = 0;
  for (const c of lastWeekUser) {
    if (c.graded_as === "hit") hit_count += 1;
    else if (c.graded_as === "miss") miss_count += 1;
    else if (c.graded_as === "close") close_count += 1;
  }

  const pending_count = teamThisWeek.filter((c) => c.graded_as == null).length;

  let northStar: GoalsDigestPayload["north_star"] = null;
  if (northStarTrend.latest) {
    let pct_change: number | null = null;
    const hist = northStarTrend.history;
    if (hist.length >= 2) {
      const prev = hist[hist.length - 2].value;
      if (prev !== 0) {
        pct_change = Math.round(((northStarTrend.latest.value - prev) / prev) * 1000) / 10;
      }
    }
    northStar = {
      label: northStarTrend.latest.label,
      value: northStarTrend.latest.value,
      unit: northStarTrend.latest.unit,
      pct_change,
    };
  }

  const summary_lines: string[] = [];
  if (northStar) {
    const arrow = northStar.pct_change == null
      ? ""
      : northStar.pct_change >= 0
        ? ` (↑${northStar.pct_change}%)`
        : ` (↓${Math.abs(northStar.pct_change)}%)`;
    summary_lines.push(
      `Team's ${northStar.label} is ${northStar.value}${northStar.unit ? ` ${northStar.unit}` : ""}${arrow}.`,
    );
  }
  summary_lines.push(
    `Last week's commits: ${hit_count} hit, ${miss_count} missed${close_count > 0 ? `, ${close_count} close` : ""}.`,
  );
  summary_lines.push(`Team's pending this week: ${pending_count}.`);
  // Fresh "this week" prompt to nudge the user to log a commitment.
  if (thisWeekUser.length === 0) {
    summary_lines.push("You haven't logged a commitment for this week yet — Friday's sync is coming up.");
  }

  return {
    user_id: opts.user_id,
    week_of: opts.week_of,
    hit_count,
    miss_count,
    close_count,
    pending_count,
    north_star: northStar,
    summary_lines,
  };
}

// ---------------------------------------------------------------------------
// Deliver
// ---------------------------------------------------------------------------

export type DeliveryResult = "sent" | "queued";

export interface DeliverGoalsDigestOpts {
  channel: GoalsDigestChannel;
  recipient: DigestRecipient;
  digest: GoalsDigestPayload;
  fetchImpl?: typeof fetch;
}

function digestSubject(digest: GoalsDigestPayload): string {
  if (digest.north_star) {
    return `Your team's North Star: ${digest.north_star.label} — week of ${digest.week_of}`;
  }
  return `Weekly goals digest — week of ${digest.week_of}`;
}

function digestPlainBody(recipient: DigestRecipient, digest: GoalsDigestPayload): string {
  return `Hi ${recipient.name.split(" ")[0]},\n\n${digest.summary_lines.join("\n\n")}\n\n— Wolfpack Instinct`;
}

async function deliverViaResend(
  recipient: DigestRecipient,
  digest: GoalsDigestPayload,
  fetchImpl: typeof fetch,
): Promise<DeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return queueForLater(recipient, digest);
  const from = process.env.INSTINCT_DIGEST_FROM ?? "goals@wolfpack.agency";
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: recipient.email,
      subject: digestSubject(digest),
      text: digestPlainBody(recipient, digest),
    }),
  });
  if (!res.ok) {
    // Fall through to the queue so we never drop a digest on the floor.
    return queueForLater(recipient, digest);
  }
  return "sent";
}

async function deliverViaTeams(
  recipient: DigestRecipient,
  digest: GoalsDigestPayload,
  fetchImpl: typeof fetch,
): Promise<DeliveryResult> {
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url) return queueForLater(recipient, digest);
  const body = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    summary: digestSubject(digest),
    title: digestSubject(digest),
    text: `**${recipient.name}**\n\n${digest.summary_lines.map((l) => `- ${l}`).join("\n")}`,
  };
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return queueForLater(recipient, digest);
  return "sent";
}

async function queueForLater(
  recipient: DigestRecipient,
  digest: GoalsDigestPayload,
): Promise<DeliveryResult> {
  // Best-effort insert — if the table doesn't exist yet (migration not
  // shipped), safeQuery returns empty rows and we treat as queued. A
  // follow-up migration creates instinct_digest_queue with:
  //   (id, user_id, week_of, kind, payload jsonb, created_at, sent_at)
  await safeQuery(
    `INSERT INTO instinct_digest_queue (user_id, week_of, kind, payload)
     VALUES ($1, $2, 'goals_weekly', $3::jsonb)
     ON CONFLICT DO NOTHING`,
    [recipient.user_id, digest.week_of, JSON.stringify(digest)],
  );
  return "queued";
}

export async function deliverGoalsDigest(
  opts: DeliverGoalsDigestOpts,
): Promise<DeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (opts.channel === "resend") {
    return deliverViaResend(opts.recipient, opts.digest, fetchImpl);
  }
  if (opts.channel === "teams") {
    return deliverViaTeams(opts.recipient, opts.digest, fetchImpl);
  }
  return queueForLater(opts.recipient, opts.digest);
}
