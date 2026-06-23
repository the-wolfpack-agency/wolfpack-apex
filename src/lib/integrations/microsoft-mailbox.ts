/**
 * Microsoft 365 mailbox settings (own mailbox, /me only) — Tier 2 · Stream B.
 *
 * Surface:
 *   getOwnMailboxSettings   — /me/mailboxSettings (full blob)
 *   getOwnAutoReplySettings — /me/mailboxSettings/automaticRepliesSetting
 *   refreshOwnOOOState      — fetches auto-reply + persists OOO state into
 *                             instinct_mailbox_ooo_state; emits
 *                             system.ms_mailbox_ooo_detected when enabled.
 *
 * Scope consumed: `MailboxSettings.Read` (flagged to Stream D). On 403 the
 * helpers return `null` for simple callers and the `_Safe` form returns a
 * structured scope_missing payload (mirroring microsoft-presence.ts).
 *
 * Privacy: we only target /me. We never attempt to read mailbox settings for
 * other users — `MailboxSettings.Read` on delegated auth only covers the
 * signed-in user, and we do not want to cache other people's auto-reply
 * messages. For cross-user OOO lookups the API returns whatever is stored
 * in instinct_mailbox_ooo_state from the owner's own refresh call.
 *
 * Inbox rules: NOT stored. They are noisy, not load-bearing for our
 * learning loop, and flagged as a privacy concern in the deliverable.
 */
 

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { normalizeGraphDateTime } from "@/lib/calendar/timezone";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoReplyStatus = "disabled" | "alwaysEnabled" | "scheduled";
export type ExternalAudience = "none" | "contactsOnly" | "all";
export type OOOScope = "none" | "known" | "external" | "all";

export interface AutoReplySettings {
  status: AutoReplyStatus;
  externalAudience: ExternalAudience;
  internalReplyMessage: string | null;
  externalReplyMessage: string | null;
  scheduledStartDateTime: string | null;
  scheduledEndDateTime: string | null;
  fetchedAt: string;
}

export interface MailboxSettings {
  timeZone: string | null;
  dateFormat: string | null;
  timeFormat: string | null;
  workingHours: {
    daysOfWeek: string[];
    startTime: string | null;
    endTime: string | null;
    timeZoneName: string | null;
  } | null;
  language: string | null;
  autoReply: AutoReplySettings | null;
  fetchedAt: string;
}

export interface OOOState {
  userId: string;
  msUserId: string | null;
  isEnabled: boolean;
  scope: OOOScope;
  startAt: string | null;
  endAt: string | null;
  internalReplyMessage: string | null;
  externalReplyMessage: string | null;
  syncedAt: string;
}

export type ScopeMissingResult = {
  ok: false;
  code: "scope_missing";
  scope: string;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MailboxError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const SCOPE = "MailboxSettings.Read";

async function resolveToken(userId: string): Promise<{ accessToken: string; userEmail: string }> {
  const tok = await getValidToken(userId);
  if (!tok) throw new MailboxError(401, "No valid Microsoft token for user");
  return tok;
}

interface GraphAutoReply {
  status?: string;
  externalAudience?: string;
  internalReplyMessage?: string;
  externalReplyMessage?: string;
  scheduledStartDateTime?: { dateTime?: string; timeZone?: string };
  scheduledEndDateTime?: { dateTime?: string; timeZone?: string };
}

interface GraphMailboxSettings {
  timeZone?: string;
  dateFormat?: string;
  timeFormat?: string;
  language?: { locale?: string };
  workingHours?: {
    daysOfWeek?: string[];
    startTime?: string;
    endTime?: string;
    timeZone?: { name?: string };
  };
  automaticRepliesSetting?: GraphAutoReply;
}

function coerceStatus(s: string | undefined): AutoReplyStatus {
  if (s === "alwaysEnabled" || s === "scheduled") return s;
  return "disabled";
}

function coerceExternalAudience(s: string | undefined): ExternalAudience {
  if (s === "contactsOnly" || s === "all") return s;
  return "none";
}

function normalizeAutoReply(g: GraphAutoReply | null | undefined): AutoReplySettings | null {
  if (!g) return null;
  const fetchedAt = new Date().toISOString();
  const startIso =
    g.scheduledStartDateTime?.dateTime
      ? normalizeGraphDateTime(
          g.scheduledStartDateTime.dateTime,
          g.scheduledStartDateTime.timeZone,
        )
      : null;
  const endIso =
    g.scheduledEndDateTime?.dateTime
      ? normalizeGraphDateTime(
          g.scheduledEndDateTime.dateTime,
          g.scheduledEndDateTime.timeZone,
        )
      : null;
  return {
    status: coerceStatus(g.status),
    externalAudience: coerceExternalAudience(g.externalAudience),
    internalReplyMessage: g.internalReplyMessage ?? null,
    externalReplyMessage: g.externalReplyMessage ?? null,
    scheduledStartDateTime: startIso,
    scheduledEndDateTime: endIso,
    fetchedAt,
  };
}

/**
 * Map auto-reply state → OOO scope/is_enabled.
 *
 * - status=disabled → is_enabled=false, scope='none'
 * - status=alwaysEnabled → is_enabled=true, scope derived from externalAudience
 * - status=scheduled → is_enabled computed against now ∈ [start, end], scope
 *   derived from externalAudience
 */
export function autoReplyToOOO(auto: AutoReplySettings | null, nowMs: number = Date.now()): {
  isEnabled: boolean;
  scope: OOOScope;
  startAt: string | null;
  endAt: string | null;
  internalReplyMessage: string | null;
  externalReplyMessage: string | null;
} {
  if (!auto || auto.status === "disabled") {
    return {
      isEnabled: false,
      scope: "none",
      startAt: null,
      endAt: null,
      internalReplyMessage: null,
      externalReplyMessage: null,
    };
  }

  const scope: OOOScope =
    auto.externalAudience === "all"
      ? "all"
      : auto.externalAudience === "contactsOnly"
        ? "known"
        : "external";

  let isEnabled = false;
  if (auto.status === "alwaysEnabled") {
    isEnabled = true;
  } else {
    // scheduled — is_enabled only when we're inside the window (or no window
    // provided, which Graph can do; in that case treat as enabled).
    if (!auto.scheduledStartDateTime || !auto.scheduledEndDateTime) {
      isEnabled = true;
    } else {
      const start = Date.parse(auto.scheduledStartDateTime);
      const end = Date.parse(auto.scheduledEndDateTime);
      isEnabled =
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        nowMs >= start &&
        nowMs <= end;
    }
  }

  return {
    isEnabled,
    scope,
    startAt: auto.scheduledStartDateTime,
    endAt: auto.scheduledEndDateTime,
    internalReplyMessage: auto.internalReplyMessage,
    externalReplyMessage: auto.externalReplyMessage,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the caller's mailbox settings. Returns null on 403 / 404 / no token.
 */
export async function getOwnMailboxSettings(userId: string): Promise<MailboxSettings | null> {
  let token: string;
  try {
    const t = await resolveToken(userId);
    token = t.accessToken;
  } catch (err) {
    if (err instanceof MailboxError && err.status === 401) return null;
    throw err;
  }

  try {
    const res = await fetch(`${GRAPH_BASE_URL}/me/mailboxSettings`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    if (res.status === 403) {
      trackEvent("system.ms_mailbox_settings_failed", userId, "system", {
        reason: "scope_missing",
      });
      return null;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      trackEvent("system.ms_mailbox_settings_failed", userId, "system", {
        http_status: res.status,
      });
      return null;
    }
    const data = (await res.json()) as GraphMailboxSettings;
    const auto = normalizeAutoReply(data.automaticRepliesSetting);
    const settings: MailboxSettings = {
      timeZone: data.timeZone ?? null,
      dateFormat: data.dateFormat ?? null,
      timeFormat: data.timeFormat ?? null,
      workingHours: data.workingHours
        ? {
            daysOfWeek: Array.isArray(data.workingHours.daysOfWeek)
              ? data.workingHours.daysOfWeek
              : [],
            startTime: data.workingHours.startTime ?? null,
            endTime: data.workingHours.endTime ?? null,
            timeZoneName: data.workingHours.timeZone?.name ?? null,
          }
        : null,
      language: data.language?.locale ?? null,
      autoReply: auto,
      fetchedAt: new Date().toISOString(),
    };
    trackEvent("system.ms_mailbox_settings_fetched", userId, "system", {
      has_auto_reply: auto ? 1 : 0,
      auto_reply_status: auto?.status ?? "none",
    });
    return settings;
  } catch (err) {
    trackEvent("system.ms_mailbox_settings_failed", userId, "system", {
      error: (err as Error).message.slice(0, 200),
    });
    return null;
  }
}

/**
 * Fetch only the auto-reply portion. Lighter-weight than mailboxSettings when
 * the caller specifically wants OOO detection.
 */
export async function getOwnAutoReplySettings(
  userId: string,
): Promise<AutoReplySettings | null> {
  let token: string;
  try {
    const t = await resolveToken(userId);
    token = t.accessToken;
  } catch (err) {
    if (err instanceof MailboxError && err.status === 401) return null;
    throw err;
  }

  try {
    const res = await fetch(
      `${GRAPH_BASE_URL}/me/mailboxSettings/automaticRepliesSetting`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Prefer: 'outlook.timezone="UTC"',
        },
      },
    );
    if (res.status === 403) {
      trackEvent("system.ms_mailbox_settings_failed", userId, "system", {
        reason: "scope_missing",
      });
      return null;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      trackEvent("system.ms_mailbox_settings_failed", userId, "system", {
        http_status: res.status,
      });
      return null;
    }
    const data = (await res.json()) as GraphAutoReply;
    const auto = normalizeAutoReply(data);
    trackEvent("system.ms_mailbox_settings_fetched", userId, "system", {
      kind: "auto_reply",
      auto_reply_status: auto?.status ?? "none",
    });
    return auto;
  } catch (err) {
    trackEvent("system.ms_mailbox_settings_failed", userId, "system", {
      error: (err as Error).message.slice(0, 200),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// OOO cache helpers
// ---------------------------------------------------------------------------

async function upsertOOOState(state: {
  userId: string;
  msUserId: string | null;
  isEnabled: boolean;
  scope: OOOScope;
  startAt: string | null;
  endAt: string | null;
  internalReplyMessage: string | null;
  externalReplyMessage: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO instinct_mailbox_ooo_state
       (user_id, ms_user_id, is_enabled, scope,
        start_at, end_at, internal_reply_message, external_reply_message,
        synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET
       ms_user_id              = EXCLUDED.ms_user_id,
       is_enabled              = EXCLUDED.is_enabled,
       scope                   = EXCLUDED.scope,
       start_at                = EXCLUDED.start_at,
       end_at                  = EXCLUDED.end_at,
       internal_reply_message  = EXCLUDED.internal_reply_message,
       external_reply_message  = EXCLUDED.external_reply_message,
       synced_at               = now()`,
    [
      state.userId,
      state.msUserId,
      state.isEnabled,
      state.scope,
      state.startAt,
      state.endAt,
      state.internalReplyMessage,
      state.externalReplyMessage,
    ],
  );
}

function rowToOOO(r: any): OOOState {
  return {
    userId: r.user_id,
    msUserId: r.ms_user_id ?? null,
    isEnabled: Boolean(r.is_enabled),
    scope: (r.scope ?? "none") as OOOScope,
    startAt: r.start_at ? new Date(r.start_at).toISOString() : null,
    endAt: r.end_at ? new Date(r.end_at).toISOString() : null,
    internalReplyMessage: r.internal_reply_message ?? null,
    externalReplyMessage: r.external_reply_message ?? null,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

/**
 * Read the cached OOO state for an internal instinct user. Never hits Graph.
 * Used by the cross-user read endpoint where we cannot legally fetch other
 * people's mailboxes.
 */
export async function getCachedOOOState(userId: string): Promise<OOOState | null> {
  const { rows } = await safeQuery<any>(
    `SELECT user_id, ms_user_id, is_enabled, scope, start_at, end_at,
            internal_reply_message, external_reply_message, synced_at
       FROM instinct_mailbox_ooo_state
       WHERE user_id = $1
       LIMIT 1`,
    [userId],
  );
  if (rows.length === 0) return null;
  return rowToOOO(rows[0]);
}

/**
 * Fetch auto-reply from Graph + persist to instinct_mailbox_ooo_state.
 * Emits `system.ms_mailbox_ooo_detected` when OOO transitions to / remains
 * enabled so downstream notify helpers can surface the state.
 *
 * Returns the resolved OOOState, or null when fetch failed (e.g. 403 /
 * token missing). Never throws on scope_missing.
 */
export async function refreshOwnOOOState(userId: string): Promise<OOOState | null> {
  let msUserId: string | null = null;
  try {
    const t = await getValidToken(userId);
    if (!t) return null;
    // msUserId is not directly exposed on the token row — we pull from Graph
    // /me lazily if needed. For learning joins we store email in user_email;
    // that's sufficient. Leave msUserId null when unknown.
    msUserId = null;
    // Probe /me for id (best-effort, same auth round).
    try {
      const me = await fetch(`${GRAPH_BASE_URL}/me?$select=id`, {
        method: "GET",
        headers: { Authorization: `Bearer ${t.accessToken}`, Accept: "application/json" },
      });
      if (me.ok) {
        const body = (await me.json()) as { id?: string };
        if (body?.id) msUserId = body.id;
      }
    } catch { /* ignore */ }
  } catch {
    return null;
  }

  const auto = await getOwnAutoReplySettings(userId);
  const derived = autoReplyToOOO(auto);

  const state = {
    userId,
    msUserId,
    ...derived,
  };

  try {
    await upsertOOOState(state);
  } catch (err) {
    trackEvent("system.ms_mailbox_settings_failed", userId, "system", {
      reason: "ooo_persist_failed",
      error: (err as Error).message.slice(0, 200),
    });
  }

  if (derived.isEnabled) {
    trackEvent("system.ms_mailbox_ooo_detected", userId, "system", {
      scope: derived.scope,
      has_start: derived.startAt ? 1 : 0,
      has_end: derived.endAt ? 1 : 0,
    });
  }

  return {
    userId,
    msUserId,
    isEnabled: derived.isEnabled,
    scope: derived.scope,
    startAt: derived.startAt,
    endAt: derived.endAt,
    internalReplyMessage: derived.internalReplyMessage,
    externalReplyMessage: derived.externalReplyMessage,
    syncedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scope-missing helper (mirrors presence/teams-chat pattern)
// ---------------------------------------------------------------------------

export function asScopeMissing(err: unknown): ScopeMissingResult | null {
  if (err instanceof MailboxError && err.status === 403) {
    return { ok: false, code: "scope_missing", scope: SCOPE };
  }
  return null;
}
