/**
 * In-app notifications — the single entry point for creating notifications.
 *
 * Other modules (hr, tasks, finance, security, integrations, team) MUST
 * call notify(...) here rather than inserting into instinct_notifications
 * directly. This keeps preferences, dedup, analytics + learning hooks in
 * one place.
 *
 * Preference semantics:
 *   - in_app = false         → notification is still recorded (no data loss)
 *                              but auto-dismissed so the bell stays quiet.
 *   - quiet_hours            → DO NOT affect in-app. The bell always shows.
 *                              Quiet hours only defer email/digest delivery.
 *   - category_overrides     → per-category email cadence override.
 *   - priority = "critical"  → bypasses quiet hours + daily/weekly batching
 *                              (routed via realtime email path, not batched
 *                              into the next digest).
 *
 * Every write emits system.notification_created. Reads → system.notification_read
 * with seconds_to_read. Dismiss → system.notification_dismissed. Click →
 * system.notification_clicked.
 */

import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type NotificationPriority = "low" | "normal" | "high" | "critical";
export type EmailDigestCadence = "off" | "realtime" | "daily" | "weekly";

export interface NotifyInput {
  userId: string;
  category: string;
  priority?: NotificationPriority;
  title: string;
  body?: string;
  actionUrl?: string;
  actionLabel?: string;
  source: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
  expiresInHours?: number;
  /** If true, skip when an existing non-read notification with same source+sourceId exists. */
  dedup?: boolean;
}

export interface Notification {
  id: string;
  user_id: string;
  category: string;
  priority: NotificationPriority;
  title: string;
  body: string | null;
  action_url: string | null;
  action_label: string | null;
  source: string;
  source_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
  clicked_at: string | null;
  expires_at: string | null;
}

export interface NotificationPreferences {
  user_id: string;
  in_app: boolean;
  email_digest: EmailDigestCadence;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  timezone: string;
  category_overrides: Record<string, EmailDigestCadence>;
  updated_at: string;
}

export interface ListFilter {
  category?: string;
  priority?: string;
  readState?: "read" | "unread" | "all";
  search?: string;
}

export interface ListOpts {
  cursor?: string;
  limit?: number;
  filter?: ListFilter;
}

const PRIORITIES: NotificationPriority[] = ["low", "normal", "high", "critical"];
const DIGEST_CADENCES: EmailDigestCadence[] = ["off", "realtime", "daily", "weekly"];

function isPriority(p: unknown): p is NotificationPriority {
  return typeof p === "string" && (PRIORITIES as string[]).includes(p);
}

function isDigestCadence(c: unknown): c is EmailDigestCadence {
  return typeof c === "string" && (DIGEST_CADENCES as string[]).includes(c);
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function asCategoryOverrides(raw: unknown): Record<string, EmailDigestCadence> {
  const rec = asRecord(raw);
  const out: Record<string, EmailDigestCadence> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (isDigestCadence(v)) out[k] = v;
  }
  return out;
}

function mapNotification(row: Record<string, unknown>): Notification {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    category: String(row.category),
    priority: (isPriority(row.priority) ? row.priority : "normal"),
    title: String(row.title),
    body: (row.body as string | null) ?? null,
    action_url: (row.action_url as string | null) ?? null,
    action_label: (row.action_label as string | null) ?? null,
    source: String(row.source),
    source_id: (row.source_id as string | null) ?? null,
    metadata: asRecord(row.metadata),
    created_at: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
    read_at: toIsoOrNull(row.read_at),
    dismissed_at: toIsoOrNull(row.dismissed_at),
    clicked_at: toIsoOrNull(row.clicked_at),
    expires_at: toIsoOrNull(row.expires_at),
  };
}

function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Fetch a user's preferences, creating defaults if none exist.
 * Defaults match migration 020.
 */
export async function getPreferences(userId: string): Promise<NotificationPreferences> {
  const result = await safeQuery<Record<string, unknown>>(
    `SELECT user_id, in_app, email_digest, quiet_hours_start, quiet_hours_end,
            timezone, category_overrides, updated_at
     FROM instinct_notification_preferences WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      user_id: userId,
      in_app: true,
      email_digest: "daily",
      quiet_hours_start: null,
      quiet_hours_end: null,
      timezone: "America/New_York",
      category_overrides: {},
      updated_at: new Date().toISOString(),
    };
  }
  return {
    user_id: String(row.user_id),
    in_app: Boolean(row.in_app),
    email_digest: (isDigestCadence(row.email_digest) ? row.email_digest : "daily"),
    quiet_hours_start: (row.quiet_hours_start as string | null) ?? null,
    quiet_hours_end: (row.quiet_hours_end as string | null) ?? null,
    timezone: String(row.timezone ?? "America/New_York"),
    category_overrides: asCategoryOverrides(row.category_overrides),
    updated_at: toIsoOrNull(row.updated_at) ?? new Date().toISOString(),
  };
}

export interface UpdatePreferencesInput {
  in_app?: boolean;
  email_digest?: EmailDigestCadence;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  timezone?: string;
  category_overrides?: Record<string, EmailDigestCadence>;
}

/**
 * Upsert preferences, validating enum fields. Returns the fresh row and a
 * map of changed fields (for the analytics payload).
 */
export async function updatePreferences(
  userId: string,
  input: UpdatePreferencesInput,
): Promise<{ preferences: NotificationPreferences; changes: string[] }> {
  if (input.email_digest !== undefined && !isDigestCadence(input.email_digest)) {
    throw new Error("invalid_email_digest");
  }
  if (input.category_overrides !== undefined) {
    for (const [, v] of Object.entries(input.category_overrides)) {
      if (!isDigestCadence(v)) throw new Error("invalid_category_override");
    }
  }

  const current = await getPreferences(userId);
  const next: NotificationPreferences = {
    ...current,
    in_app: input.in_app ?? current.in_app,
    email_digest: input.email_digest ?? current.email_digest,
    quiet_hours_start:
      input.quiet_hours_start === undefined
        ? current.quiet_hours_start
        : input.quiet_hours_start,
    quiet_hours_end:
      input.quiet_hours_end === undefined
        ? current.quiet_hours_end
        : input.quiet_hours_end,
    timezone: input.timezone ?? current.timezone,
    category_overrides: input.category_overrides ?? current.category_overrides,
    updated_at: new Date().toISOString(),
  };

  const changes: string[] = [];
  for (const key of [
    "in_app",
    "email_digest",
    "quiet_hours_start",
    "quiet_hours_end",
    "timezone",
    "category_overrides",
  ] as const) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) {
      changes.push(key);
    }
  }

  await safeQuery(
    `INSERT INTO instinct_notification_preferences
       (user_id, in_app, email_digest, quiet_hours_start, quiet_hours_end, timezone, category_overrides, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       in_app = EXCLUDED.in_app,
       email_digest = EXCLUDED.email_digest,
       quiet_hours_start = EXCLUDED.quiet_hours_start,
       quiet_hours_end = EXCLUDED.quiet_hours_end,
       timezone = EXCLUDED.timezone,
       category_overrides = EXCLUDED.category_overrides,
       updated_at = NOW()`,
    [
      userId,
      next.in_app,
      next.email_digest,
      next.quiet_hours_start,
      next.quiet_hours_end,
      next.timezone,
      JSON.stringify(next.category_overrides),
    ],
  );

  return { preferences: next, changes };
}

/**
 * Create a notification. Returns the new id, or { deduped: true } when
 * dedup is requested and an equivalent unread notification already exists.
 */
export async function notify(
  input: NotifyInput,
): Promise<{ id: string } | { deduped: true }> {
  const priority: NotificationPriority = input.priority ?? "normal";
  if (!PRIORITIES.includes(priority)) {
    throw new Error("invalid_priority");
  }
  if (!input.userId || !input.category || !input.title || !input.source) {
    throw new Error("missing_required_fields");
  }

  const prefs = await getPreferences(input.userId);

  // Dedup path: if a matching non-read, non-dismissed notification exists,
  // skip the insert.
  if (input.dedup && input.sourceId) {
    const existing = await safeQuery<{ id: string }>(
      `SELECT id FROM instinct_notifications
         WHERE source = $1 AND source_id = $2
           AND user_id = $3
           AND read_at IS NULL
           AND dismissed_at IS NULL
         LIMIT 1`,
      [input.source, input.sourceId, input.userId],
    );
    if (existing.rows.length > 0) {
      return { deduped: true };
    }
  }

  const expiresAt = input.expiresInHours
    ? new Date(Date.now() + input.expiresInHours * 3600 * 1000).toISOString()
    : null;

  const metadata = input.metadata ?? {};

  // If the user has disabled in-app, auto-dismiss so the bell stays silent,
  // but still record the row (no data loss; email digest path can still
  // pick it up).
  const autoDismiss = prefs.in_app === false;

  const result = await query<{ id: string }>(
    `INSERT INTO instinct_notifications
       (user_id, category, priority, title, body, action_url, action_label,
        source, source_id, metadata, expires_at, dismissed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
     RETURNING id`,
    [
      input.userId,
      input.category,
      priority,
      input.title,
      input.body ?? null,
      input.actionUrl ?? null,
      input.actionLabel ?? null,
      input.source,
      input.sourceId ?? null,
      JSON.stringify(metadata),
      expiresAt,
      autoDismiss ? new Date().toISOString() : null,
    ],
  );

  const id = result.rows[0]?.id;
  if (!id) throw new Error("insert_failed");

  trackEvent("system.notification_created", input.userId, "system", {
    notification_id: String(id),
    recipient_user_id: input.userId,
    category: input.category,
    priority,
    source: input.source,
  });

  return { id: String(id) };
}

/**
 * Create many notifications. Runs notify() sequentially so each respects
 * preferences + dedup independently. Errors on individual rows do not
 * halt the batch.
 */
export async function notifyMany(inputs: NotifyInput[]): Promise<void> {
  for (const input of inputs) {
    try {
      await notify(input);
    } catch (err) {
      console.warn("[notifications] notifyMany skipped row:", (err as Error).message);
    }
  }
}

async function loadOwned(
  notificationId: string,
  userId: string,
): Promise<Notification | null> {
  const result = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM instinct_notifications WHERE id = $1 AND user_id = $2`,
    [notificationId, userId],
  );
  if (result.rows.length === 0) return null;
  return mapNotification(result.rows[0]);
}

export async function markRead(
  notificationId: string,
  userId: string,
): Promise<void> {
  const existing = await loadOwned(notificationId, userId);
  if (!existing) return;
  if (existing.read_at) return; // already read, idempotent

  await safeQuery(
    `UPDATE instinct_notifications SET read_at = NOW()
       WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [notificationId, userId],
  );

  const createdAt = new Date(existing.created_at).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  trackEvent("system.notification_read", userId, "system", {
    notification_id: notificationId,
    user_id: userId,
    seconds_to_read: seconds,
  });
}

export async function markAllRead(userId: string): Promise<number> {
  const result = await safeQuery<{ id: string; created_at: string | Date }>(
    `UPDATE instinct_notifications SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL
     RETURNING id, created_at`,
    [userId],
  );
  for (const row of result.rows) {
    const createdAt =
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : new Date(row.created_at).getTime();
    trackEvent("system.notification_read", userId, "system", {
      notification_id: String(row.id),
      user_id: userId,
      seconds_to_read: Math.max(
        0,
        Math.round((Date.now() - createdAt) / 1000),
      ),
    });
  }
  return result.rows.length;
}

export async function dismiss(
  notificationId: string,
  userId: string,
): Promise<void> {
  const existing = await loadOwned(notificationId, userId);
  if (!existing) return;
  if (existing.dismissed_at) return;

  await safeQuery(
    `UPDATE instinct_notifications SET dismissed_at = NOW()
       WHERE id = $1 AND user_id = $2 AND dismissed_at IS NULL`,
    [notificationId, userId],
  );

  trackEvent("system.notification_dismissed", userId, "system", {
    notification_id: notificationId,
    user_id: userId,
  });
}

export async function recordClick(
  notificationId: string,
  userId: string,
): Promise<{ action_url: string | null }> {
  const existing = await loadOwned(notificationId, userId);
  if (!existing) return { action_url: null };

  await safeQuery(
    `UPDATE instinct_notifications
       SET clicked_at = COALESCE(clicked_at, NOW()),
           read_at = COALESCE(read_at, NOW())
       WHERE id = $1 AND user_id = $2`,
    [notificationId, userId],
  );

  trackEvent("system.notification_clicked", userId, "system", {
    notification_id: notificationId,
    user_id: userId,
    action_url: existing.action_url ?? "",
  });

  return { action_url: existing.action_url };
}

/** Clause fragment shared by list queries to hide expired + dismissed from UI. */
const VISIBILITY_WHERE = `
  user_id = $1
  AND dismissed_at IS NULL
  AND (expires_at IS NULL OR expires_at > NOW())
`;

export async function listUnread(
  userId: string,
  opts: { limit?: number } = {},
): Promise<Notification[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const result = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM instinct_notifications
       WHERE ${VISIBILITY_WHERE} AND read_at IS NULL
       ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map(mapNotification);
}

export async function unreadCount(userId: string): Promise<number> {
  const result = await safeQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM instinct_notifications
       WHERE ${VISIBILITY_WHERE} AND read_at IS NULL`,
    [userId],
  );
  const row = result.rows[0];
  return row ? Number(row.count) : 0;
}

export async function listAll(
  userId: string,
  opts: ListOpts = {},
): Promise<{ notifications: Notification[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const params: unknown[] = [userId];
  let where = VISIBILITY_WHERE;

  const filter = opts.filter ?? {};
  if (filter.category) {
    params.push(filter.category);
    where += ` AND category = $${params.length}`;
  }
  if (filter.priority) {
    params.push(filter.priority);
    where += ` AND priority = $${params.length}`;
  }
  if (filter.readState === "unread") {
    where += ` AND read_at IS NULL`;
  } else if (filter.readState === "read") {
    where += ` AND read_at IS NOT NULL`;
  }
  if (filter.search) {
    params.push(`%${filter.search}%`);
    const idx = params.length;
    where += ` AND (title ILIKE $${idx} OR body ILIKE $${idx})`;
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    where += ` AND created_at < $${params.length}`;
  }

  params.push(limit + 1);
  const limitIdx = params.length;

  const result = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM instinct_notifications
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx}`,
    params,
  );

  const rows = result.rows.map(mapNotification);
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const last = rows[limit - 1];
    nextCursor = last.created_at;
    rows.splice(limit);
  }
  return { notifications: rows, nextCursor };
}
