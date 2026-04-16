/**
 * Microsoft 365 Presence integration.
 *
 * Graph `/me/presence` returns the signed-in user's availability and
 * activity (Available, Busy, DoNotDisturb, Away, Offline + free-form
 * activity). We return real-time only — NO cache — so the PresenceIndicator
 * always reflects current state. Callers should client-cache for ~30s to
 * keep request rates reasonable.
 *
 * Scope: Presence.Read (already in MS_SCOPES).
 *
 * On 403 returns null. Never throws on scope_missing from the primary
 * helper (`getOwnPresence`). The _Safe form returns a discriminated
 * scope_missing payload.
 */

import { getValidToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresenceAvailability =
  | "Available"
  | "AvailableIdle"
  | "Away"
  | "BeRightBack"
  | "Busy"
  | "BusyIdle"
  | "DoNotDisturb"
  | "Offline"
  | "PresenceUnknown";

export type PresenceActivity =
  | "Available"
  | "Away"
  | "BeRightBack"
  | "Busy"
  | "DoNotDisturb"
  | "InACall"
  | "InAConferenceCall"
  | "Inactive"
  | "InAMeeting"
  | "Offline"
  | "OffWork"
  | "OutOfOffice"
  | "PresenceUnknown"
  | "Presenting"
  | "UrgentInterruptionsOnly";

export interface Presence {
  availability: PresenceAvailability;
  activity: PresenceActivity;
  statusMessage: string | null;
  fetchedAt: string;
}

export type ScopeMissingResult = { ok: false; code: "scope_missing"; scope: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GraphPresenceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GraphPresenceError";
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new GraphPresenceError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

interface GraphPresence {
  availability?: string;
  activity?: string;
  statusMessage?: { message?: { content?: string } } | null;
}

/**
 * Get the current user's presence. Returns null on 403 (scope missing),
 * 404, or unknown / unreachable. Emits `system.ms_presence_fetched`.
 */
export async function getOwnPresence(userId: string): Promise<Presence | null> {
  let token: string;
  try {
    token = await resolveToken(userId);
  } catch (err) {
    if (err instanceof GraphPresenceError && err.status === 401) return null;
    throw err;
  }

  const url = `${GRAPH_BASE_URL}/me/presence`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 403) {
      trackEvent("system.ms_presence_fetched", userId, "system", {
        ok: false,
        scope_missing: true,
      });
      return null;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new GraphPresenceError(res.status, `Graph presence fetch failed: ${res.status}`);
    }
    const data = (await res.json()) as GraphPresence;
    const presence: Presence = {
      availability: (data.availability as PresenceAvailability) ?? "PresenceUnknown",
      activity: (data.activity as PresenceActivity) ?? "PresenceUnknown",
      statusMessage: data.statusMessage?.message?.content ?? null,
      fetchedAt: new Date().toISOString(),
    };
    trackEvent("system.ms_presence_fetched", userId, "system", {
      availability: presence.availability,
      activity: presence.activity,
      has_status: presence.statusMessage ? 1 : 0,
    });
    return presence;
  } catch (err) {
    trackEvent("system.ms_presence_fetched", userId, "system", {
      ok: false,
      error: (err as Error).message.slice(0, 120),
    });
    // Presence is best-effort — swallow transient errors.
    return null;
  }
}

export async function getOwnPresence_Safe(
  userId: string,
): Promise<{ ok: true; presence: Presence | null } | ScopeMissingResult> {
  // Main helper already maps 403 → null; we need to repeat the check here
  // to surface the structured discriminator. Keep in sync with getOwnPresence.
  let token: string;
  try {
    token = await resolveToken(userId);
  } catch {
    return { ok: true, presence: null };
  }
  try {
    const res = await fetch(`${GRAPH_BASE_URL}/me/presence`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 403) return { ok: false, code: "scope_missing", scope: "Presence.Read" };
    if (!res.ok) return { ok: true, presence: null };
    const data = (await res.json()) as GraphPresence;
    return {
      ok: true,
      presence: {
        availability: (data.availability as PresenceAvailability) ?? "PresenceUnknown",
        activity: (data.activity as PresenceActivity) ?? "PresenceUnknown",
        statusMessage: data.statusMessage?.message?.content ?? null,
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch {
    return { ok: true, presence: null };
  }
}
