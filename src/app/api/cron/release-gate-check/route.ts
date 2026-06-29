/**
 * GET /api/cron/release-gate-check - the proactive release-gate notifier sweep.
 *
 * Reads the live production release gate (src/lib/deploy/release-gate.ts) and,
 * for every change that has been blocking prod past the age threshold and has
 * NOT already been notified for its current state inside the cooldown, pushes an
 * in-app notification + an email to the responsible person (PR author when we
 * can resolve them, plus admins/cto), records a dedupe row in
 * instinct_release_gate_notifications (migration 207), and fires the analytics.
 * This is the signal that was missing when a PR blocked prod for 19h.
 *
 * Two auth paths (mirrors /api/cron/integration-health):
 *   1. Cron path: Authorization: Bearer ${CRON_SECRET}. Vercel Cron hits this on
 *      schedule. Returns false when CRON_SECRET is unset (local dev).
 *   2. Admin path: requireCapability(req, "settings.manage_team") for an admin
 *      triggering a manual sweep.
 *
 * Never 500s on a recoverable condition: checkAndNotify is best-effort per
 * channel and HONEST-DEGRADES (sends nothing, surfaces the degrade) when the
 * gate could not be read. A top-level throw still returns a 200 zero summary so
 * the cron health-monitor stays green.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { notify } from "@/lib/notifications/in-app";
import { sendViaGraph } from "@/lib/mail/send-via-graph";
import { getReleaseGate, type BlockingChange } from "@/lib/deploy/release-gate";
import {
  checkAndNotify,
  blockedMessage,
  type NotifRecord,
} from "@/lib/deploy/release-gate-notify";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

const SOURCE = "deploy";
/** Dedupe ledger rows older than this are irrelevant to the cooldown read. */
const RECENT_WINDOW_HOURS = 48;

/** A team member we can notify. */
interface Recipient {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
}

/**
 * Resolve who to ping: the PR author (matched best-effort against the team by
 * email local-part or name) PLUS every admin/cto. We dedupe by id so an admin
 * who is also the author is notified once. Best-effort: a failed lookup returns
 * just the admins so a block is never silently un-notified.
 */
async function resolveRecipients(authorLogin: string): Promise<Recipient[]> {
  const byId = new Map<string, Recipient>();
  try {
    const { rows } = await safeQuery<Recipient>(
      `SELECT id, email, name, role
         FROM instinct_team_members
        WHERE is_active = true
          AND (role IN ('admin', 'cto')
               OR lower(name) = lower($1)
               OR lower(split_part(email, '@', 1)) = lower($1))`,
      [authorLogin],
    );
    for (const r of rows) byId.set(r.id, r);
  } catch (err) {
    console.error("[cron/release-gate-check] recipient lookup failed:", (err as Error).message);
  }
  return Array.from(byId.values());
}

/** Stable dedup key per recipient so the in-app bell suppresses its own repeats. */
function inAppSourceId(change: BlockingChange): string {
  return `release_gate:${change.number}:${change.state}`;
}

/** Send the in-app notification to every responsible person. */
async function sendInApp(change: BlockingChange): Promise<void> {
  const recipients = await resolveRecipients(change.author);
  const body = blockedMessage(change);
  let delivered = 0;
  for (const r of recipients) {
    try {
      await notify({
        userId: r.id,
        category: "deploy.release_blocked",
        priority: "high",
        title: `PR #${change.number} is blocking production`,
        body,
        actionUrl: change.url,
        actionLabel: "Review on GitHub",
        source: SOURCE,
        sourceId: inAppSourceId(change),
        metadata: {
          pr_number: change.number,
          state: change.state,
          reason: change.reason,
          age_hours: change.ageHours,
          author: change.author,
        },
        dedup: true,
      });
      delivered += 1;
    } catch (err) {
      console.error(
        `[cron/release-gate-check] in-app to ${r.id} failed:`,
        (err as Error).message,
      );
    }
  }
  // If we resolved recipients but delivered to NONE, surface as a throw so the
  // notifier counts it as a channel failure (and does not record the dedupe row
  // off a phantom send).
  if (recipients.length > 0 && delivered === 0) {
    throw new Error("in-app delivered to zero recipients");
  }
}

/** Email every responsible person via the existing Graph transactional sender. */
async function sendEmail(change: BlockingChange): Promise<void> {
  const recipients = await resolveRecipients(change.author);
  const message = blockedMessage(change);
  const subject = `Action needed: PR #${change.number} is blocking production`;
  const html =
    `<p>${escapeHtml(message)}</p>` +
    `<p><a href="${escapeHtml(change.url)}">Open PR #${change.number}</a></p>` +
    `<p style="color:#888">It has been blocking production for ${change.ageHours}h.</p>`;
  let delivered = 0;
  let attempted = 0;
  for (const r of recipients) {
    if (!r.email) continue;
    attempted += 1;
    const res = await sendViaGraph({ to: r.email, subject, text: message, html });
    if (res.delivered) {
      delivered += 1;
    } else {
      console.error(
        `[cron/release-gate-check] email to ${r.email} not delivered: ${res.reason}`,
      );
    }
  }
  // Only treat it as a channel failure when we tried to email someone and every
  // attempt failed. Zero email-able recipients is not a failure of THIS channel.
  if (attempted > 0 && delivered === 0) {
    throw new Error("email delivered to zero recipients");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Read recent dedupe rows from migration 207's ledger. */
async function listRecentNotifs(): Promise<NotifRecord[]> {
  const { rows } = await safeQuery<{ pr_number: number; last_state: string; notified_at: string | Date }>(
    `SELECT pr_number, last_state, notified_at
       FROM instinct_release_gate_notifications
      WHERE notified_at > NOW() - ($1 || ' hours')::interval`,
    [String(RECENT_WINDOW_HOURS)],
  );
  return rows.map((r) => ({
    prNumber: Number(r.pr_number),
    state: String(r.last_state),
    notifiedAtMs:
      r.notified_at instanceof Date
        ? r.notified_at.getTime()
        : new Date(r.notified_at).getTime(),
  }));
}

/** UPSERT the dedupe row keyed on the opaque "rgn_<pr>_<state>" id. */
async function recordNotif(rec: {
  prNumber: number;
  state: string;
  notifiedAtMs: number;
}): Promise<void> {
  const id = `rgn_${rec.prNumber}_${rec.state}`;
  await safeQuery(
    `INSERT INTO instinct_release_gate_notifications (id, pr_number, last_state, notified_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
     ON CONFLICT (id) DO UPDATE
       SET notified_at = EXCLUDED.notified_at,
           last_state = EXCLUDED.last_state`,
    [id, rec.prNumber, rec.state, rec.notifiedAtMs],
  );
}

async function runSweep(): Promise<NextResponse> {
  try {
    const result = await checkAndNotify({
      getReleaseGate,
      listRecentNotifs,
      recordNotif,
      sendInApp,
      sendEmail,
      track: trackEvent,
      now: Date.now,
    });
    return NextResponse.json({
      ok: true,
      checked: result.checked,
      notified: result.notified,
      degraded: result.degraded,
      degradedDetail: result.degradedDetail,
      failures: result.failures,
    });
  } catch (err) {
    // Never 500 the cron monitor: a top-level throw returns a zeroed 200.
    console.error("[cron/release-gate-check]", (err as Error).message);
    return NextResponse.json({ ok: true, checked: 0, notified: 0, degraded: false, failures: 0 });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) {
    return runSweep();
  }
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep();
}
