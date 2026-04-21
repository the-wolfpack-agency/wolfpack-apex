/**
 * GET /api/jobs/goals-digest — weekly goals digest (Monday 09:00).
 *
 * Trigger: external scheduler. No existing cron infrastructure in this
 * repo (no vercel.json crons array, no in-repo job runner). The
 * expected wiring is Vercel Cron configured in vercel.json:
 *
 *   { "crons": [{ "path": "/api/jobs/goals-digest", "schedule": "0 9 * * 1" }] }
 *
 * Until that lands in production a curl from GitHub Actions (already
 * used for shadow-hardening jobs — see wolfpack-auto/.github/workflows)
 * is the fallback. The route itself is idempotent — running it twice in
 * the same week just produces two digest writes; the digest queue table
 * dedups on (user_id, week_of) when a delivery channel is chosen.
 *
 * Authentication: requires either
 *   - Authorization: Bearer <INSTINCT_CRON_SECRET>  (external scheduler), OR
 *   - a valid user JWT with role ∈ {ceo, cto}       (manual admin trigger)
 *
 * Delivery channel resolution (runtime — first available wins):
 *   1. RESEND_API_KEY        → send per-user email
 *   2. TEAMS_WEBHOOK_URL     → post one card per user
 *   3. fallback              → insert into instinct_digest_queue for
 *                               later fan-out; operators pick it up with
 *                               /api/admin/goals-digest-queue (TODO).
 *
 * Response: { ok: true, sent, queued, skipped, week_of, channel }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  buildGoalsDigest,
  deliverGoalsDigest,
  resolveDigestChannel,
  type GoalsDigestChannel,
} from "@/lib/goals-digest";
import { trackEvent } from "@/lib/analytics";
import { safeQuery } from "@/lib/db";

// Returns the YYYY-MM-DD Monday for the week containing `now`, in UTC.
export function currentWeekOfMonday(now: Date = new Date()): string {
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  // getUTCDay: 0=Sun, 1=Mon, ... 6=Sat. Shift so Monday anchors the week.
  const dayOfWeek = d.getUTCDay();
  const offset = (dayOfWeek + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.INSTINCT_CRON_SECRET;
  if (secret && auth === `Bearer ${secret}`) return true;
  const user = getUserFromRequest(auth);
  return Boolean(user && (user.role === "ceo" || user.role === "cto"));
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const weekOverride = url.searchParams.get("week_of");
  const week_of = weekOverride && /^\d{4}-\d{2}-\d{2}$/.test(weekOverride)
    ? weekOverride
    : currentWeekOfMonday();

  const channel: GoalsDigestChannel = resolveDigestChannel();

  // Candidate recipients: every user who has EITHER graded a commitment
  // this week OR has a pending commitment for next week. We also pull
  // every team member so "no activity this week" digests still surface
  // the team's North Star number (the whole point of the digest is to
  // keep awareness high even when the individual user had a quiet week).
  const { rows: teamRows } = await safeQuery<{
    id: string;
    email: string;
    role: string;
    name: string;
  }>(
    `SELECT id, email, role, name
       FROM instinct_team_members
      WHERE is_active = true`,
  );

  const recipients = teamRows.map((r) => ({
    user_id: String(r.id),
    email: String(r.email),
    role: String(r.role),
    name: String(r.name),
  }));

  let sent = 0;
  let queued = 0;
  let skipped = 0;

  for (const r of recipients) {
    try {
      const digest = await buildGoalsDigest({
        user_id: r.user_id,
        week_of,
      });
      if (
        digest.hit_count === 0 &&
        digest.miss_count === 0 &&
        digest.pending_count === 0 &&
        !digest.north_star
      ) {
        skipped += 1;
        continue;
      }
      const result = await deliverGoalsDigest({
        channel,
        recipient: r,
        digest,
      });
      if (result === "sent") sent += 1;
      else queued += 1;

      trackEvent("goal.digest_sent", r.user_id, r.role, {
        user_id: r.user_id,
        hit_count: digest.hit_count,
        miss_count: digest.miss_count,
        pending_count: digest.pending_count,
        channel,
      });
    } catch (err) {
      console.warn(
        "[goals-digest] failed for user",
        r.user_id,
        (err as Error).message,
      );
      skipped += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    sent,
    queued,
    skipped,
    week_of,
    channel,
  });
}
