/**
 * Notification digests — email rollup of unread notifications per user.
 *
 * buildDigestForUser() collects unread notifications in a time window
 * (respecting preferences + category overrides), groups them by category,
 * and returns a payload ready for templating.
 *
 * sendDigests() iterates users whose email_digest prefs match the given
 * window, restricts to those currently inside their local morning window,
 * and hands off to the existing email path.
 *
 * No cron is wired here — call sendDigests() from a scheduler entry point
 * or via POST /api/admin/notifications/trigger-digest for testing.
 *
 * TODO: scheduler wiring. Today this is triggered manually + from tests.
 */

import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import {
  getPreferences,
  type EmailDigestCadence,
  type Notification,
  type NotificationPreferences,
} from "@/lib/notifications/in-app";

export type DigestWindow = "daily" | "weekly";

export interface DigestGroup {
  category: string;
  notifications: Notification[];
}

export interface DigestPayload {
  user_id: string;
  window: DigestWindow;
  window_started_at: string;
  window_ended_at: string;
  total: number;
  groups: DigestGroup[];
  preferences: NotificationPreferences;
}

function hoursForWindow(window: DigestWindow): number {
  return window === "weekly" ? 24 * 7 : 24;
}

function mapNotificationRow(row: Record<string, unknown>): Notification {
  const parseTs = (v: unknown) =>
    v instanceof Date ? v.toISOString() : v == null ? null : String(v);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    category: String(row.category),
    priority: ((): Notification["priority"] => {
      const p = String(row.priority);
      return p === "low" || p === "high" || p === "critical" ? p : "normal";
    })(),
    title: String(row.title),
    body: (row.body as string | null) ?? null,
    action_url: (row.action_url as string | null) ?? null,
    action_label: (row.action_label as string | null) ?? null,
    source: String(row.source),
    source_id: (row.source_id as string | null) ?? null,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    created_at: parseTs(row.created_at) ?? new Date().toISOString(),
    read_at: parseTs(row.read_at),
    dismissed_at: parseTs(row.dismissed_at),
    clicked_at: parseTs(row.clicked_at),
    expires_at: parseTs(row.expires_at),
  };
}

/**
 * Build a user's digest. Respects category_overrides — if the user has set
 * a category to "off", those notifications are excluded from the digest
 * (they still live in the bell / inbox). Critical notifications are always
 * included, regardless of override.
 */
export async function buildDigestForUser(
  userId: string,
  window: DigestWindow,
): Promise<DigestPayload> {
  const prefs = await getPreferences(userId);
  const hours = hoursForWindow(window);
  const startedAt = new Date(Date.now() - hours * 3600 * 1000);
  const endedAt = new Date();

  const result = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM instinct_notifications
       WHERE user_id = $1
         AND read_at IS NULL
         AND dismissed_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
         AND created_at >= $2
         AND created_at <= $3
       ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         created_at DESC`,
    [userId, startedAt.toISOString(), endedAt.toISOString()],
  );

  const allNotifs = result.rows.map(mapNotificationRow);

  // Filter by category overrides: if a category is set to "off", drop
  // (but never drop critical).
  const filtered = allNotifs.filter((n) => {
    if (n.priority === "critical") return true;
    const override = prefs.category_overrides[n.category];
    if (override === "off") return false;
    return true;
  });

  const groupsMap = new Map<string, Notification[]>();
  for (const n of filtered) {
    const arr = groupsMap.get(n.category) ?? [];
    arr.push(n);
    groupsMap.set(n.category, arr);
  }

  const groups: DigestGroup[] = Array.from(groupsMap.entries())
    .map(([category, notifications]) => ({ category, notifications }))
    .sort((a, b) => b.notifications.length - a.notifications.length);

  return {
    user_id: userId,
    window,
    window_started_at: startedAt.toISOString(),
    window_ended_at: endedAt.toISOString(),
    total: filtered.length,
    groups,
    preferences: prefs,
  };
}

/**
 * Given a user's timezone and the current moment, return whether the user
 * is currently inside their morning-send window (default 07:00–09:00 local).
 * This is intentionally permissive — the caller decides the window bounds.
 */
export function isInMorningWindow(
  tz: string,
  now: Date = new Date(),
  windowStartHour = 7,
  windowEndHour = 9,
): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "numeric",
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    const hour = hourPart ? Number(hourPart.value) : -1;
    if (Number.isNaN(hour) || hour < 0) return false;
    return hour >= windowStartHour && hour < windowEndHour;
  } catch {
    return false;
  }
}

/** Abstraction so tests can inject a capture function. */
export interface DigestSender {
  send(payload: DigestPayload): Promise<void>;
}

/**
 * Default sender — logs the payload. In production this should wire into
 * the existing email transport. Kept as a seam so we don't create a hard
 * dependency until the email client is selected.
 *
 * TODO: wire to Resend / SES / whatever the existing email path becomes.
 */
const defaultSender: DigestSender = {
  async send(payload: DigestPayload) {
    console.info(
      `[notifications/digest] would send ${payload.window} digest to ${payload.user_id}: ` +
        `${payload.total} items across ${payload.groups.length} categories`,
    );
  },
};

export interface SendDigestsOpts {
  window: DigestWindow;
  sender?: DigestSender;
  now?: Date;
  /** Force-send even if user is outside morning window. Used by the admin trigger route. */
  force?: boolean;
  /** Morning window bounds; defaults to 07–09 local. */
  windowStartHour?: number;
  windowEndHour?: number;
}

export interface SendDigestsResult {
  considered: number;
  sent: number;
  skipped_off: number;
  skipped_outside_window: number;
  skipped_empty: number;
  errors: number;
}

/**
 * Iterate all users whose email_digest cadence matches `window`, restrict
 * to those in their morning send window, build + send a digest each.
 */
export async function sendDigests(
  opts: SendDigestsOpts,
): Promise<SendDigestsResult> {
  const sender = opts.sender ?? defaultSender;
  const now = opts.now ?? new Date();
  const startHour = opts.windowStartHour ?? 7;
  const endHour = opts.windowEndHour ?? 9;

  const result: SendDigestsResult = {
    considered: 0,
    sent: 0,
    skipped_off: 0,
    skipped_outside_window: 0,
    skipped_empty: 0,
    errors: 0,
  };

  // Pull candidate users from preferences table, plus any user with
  // unread notifications who has no prefs row (defaults = daily digest).
  const prefs = await safeQuery<Record<string, unknown>>(
    `SELECT user_id, email_digest, timezone
       FROM instinct_notification_preferences
       WHERE email_digest = $1`,
    [opts.window],
  );
  const candidates: { user_id: string; email_digest: EmailDigestCadence; timezone: string }[] =
    prefs.rows.map((r) => ({
      user_id: String(r.user_id),
      email_digest: String(r.email_digest) as EmailDigestCadence,
      timezone: String(r.timezone ?? "America/New_York"),
    }));

  if (opts.window === "daily") {
    // Default cadence is 'daily', so users with no prefs row count too.
    const defaults = await safeQuery<{ user_id: string }>(
      `SELECT DISTINCT n.user_id
         FROM instinct_notifications n
         LEFT JOIN instinct_notification_preferences p
           ON p.user_id = n.user_id
         WHERE p.user_id IS NULL
           AND n.read_at IS NULL
           AND n.dismissed_at IS NULL`,
      [],
    );
    for (const r of defaults.rows) {
      candidates.push({
        user_id: String(r.user_id),
        email_digest: "daily",
        timezone: "America/New_York",
      });
    }
  }

  for (const cand of candidates) {
    result.considered += 1;
    if (cand.email_digest === "off") {
      result.skipped_off += 1;
      continue;
    }
    if (!opts.force && !isInMorningWindow(cand.timezone, now, startHour, endHour)) {
      result.skipped_outside_window += 1;
      continue;
    }
    try {
      const payload = await buildDigestForUser(cand.user_id, opts.window);
      if (payload.total === 0) {
        result.skipped_empty += 1;
        continue;
      }
      await sender.send(payload);
      trackEvent("system.notification_digest_sent", cand.user_id, "system", {
        user_id: cand.user_id,
        count: payload.total,
        window: opts.window,
      });
      result.sent += 1;
    } catch (err) {
      console.warn(
        "[notifications/digest] send failed:",
        (err as Error).message,
      );
      result.errors += 1;
    }
  }

  return result;
}
