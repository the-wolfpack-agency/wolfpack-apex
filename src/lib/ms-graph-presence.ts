/**
 * Microsoft Graph — Teams presence (Phase 1, read-only).
 *
 * Read-only surface over `/me/presence` (caller) and
 * `/communications/getPresencesByUserId` (batch). We request the
 * `Presence.Read` delegated scope only.
 *
 * Batching: Graph's batch-presence endpoint accepts up to 650 IDs per
 * POST; we chunk larger inputs and merge the results. Returns a
 * `Map<userId, Presence>` so the caller can look up quickly without
 * an O(n) scan.
 *
 * Error handling:
 * - 401/403 → translated to `ms_presence.scope_missing` analytics,
 *   returns an empty Map. Never throws.
 * - Network / 5xx → returns whatever partial results succeeded.
 */

import { trackEvent } from "@/lib/analytics";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/**
 * Graph's documented max IDs per `getPresencesByUserId` POST. We keep
 * this as the batch-chunk size; change both constants together if
 * Graph raises / lowers the limit.
 */
export const PRESENCE_BATCH_MAX = 650;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PresenceAvailability =
  | "Available"
  | "Busy"
  | "DoNotDisturb"
  | "Away"
  | "BeRightBack"
  | "Offline"
  | "PresenceUnknown";

export interface Presence {
  userId: string;
  availability: PresenceAvailability;
  activity: string;
}

export type ScopeMissingResult = {
  ok: false;
  code: "scope_missing";
  scope: "Presence.Read";
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawPresence {
  id?: string;
  availability?: string;
  activity?: string;
}

function normalizeAvailability(a: string | undefined): PresenceAvailability {
  switch (a) {
    case "Available":
    case "Busy":
    case "DoNotDisturb":
    case "Away":
    case "BeRightBack":
    case "Offline":
    case "PresenceUnknown":
      return a;
    // Graph also returns idle-suffixed variants for Available / Busy.
    case "AvailableIdle":
      return "Available";
    case "BusyIdle":
      return "Busy";
    default:
      return "PresenceUnknown";
  }
}

function normalizePresence(raw: RawPresence, fallbackId: string): Presence {
  return {
    userId: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : fallbackId,
    availability: normalizeAvailability(raw.availability),
    activity: typeof raw.activity === "string" ? raw.activity : "",
  };
}

/**
 * Split `ids` into batches of `size`. Exported for tests.
 */
export function chunkUserIds(ids: string[], size: number = PRESENCE_BATCH_MAX): string[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += safeSize) {
    out.push(ids.slice(i, i + safeSize));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch presence for a batch of users. Accepts any number of IDs;
 * chunks to `PRESENCE_BATCH_MAX` per POST. Duplicates are de-duped
 * before the wire call. Unknown / unresolved IDs are simply absent
 * from the returned Map.
 */
export async function getPresence(
  userMsToken: string,
  userIds: string[],
  userId: string = "system",
): Promise<Map<string, Presence>> {
  const result = new Map<string, Presence>();
  const uniqueIds = Array.from(new Set((userIds || []).filter((id) => typeof id === "string" && id.length > 0)));
  if (uniqueIds.length === 0) {
    trackEvent("ms_presence.batch_fetched", userId, "system", { count: 0 });
    return result;
  }

  const batches = chunkUserIds(uniqueIds, PRESENCE_BATCH_MAX);
  let scopeMissing = false;

  for (const batch of batches) {
    try {
      const res = await fetch(`${GRAPH_BASE_URL}/communications/getPresencesByUserId`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userMsToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: batch }),
      });
      if (res.status === 401 || res.status === 403) {
        scopeMissing = true;
        break;
      }
      if (!res.ok) {
        console.warn(`[ms-graph-presence] batch returned ${res.status}`);
        continue;
      }
      const data = (await res.json()) as { value?: RawPresence[] };
      const rows = Array.isArray(data?.value) ? data!.value : [];
      for (const row of rows) {
        const fallback = typeof row.id === "string" ? row.id : "";
        if (!fallback) continue;
        result.set(fallback, normalizePresence(row, fallback));
      }
    } catch (err) {
      console.warn(`[ms-graph-presence] batch fetch error:`, (err as Error).message);
    }
  }

  if (scopeMissing) {
    trackEvent("ms_presence.scope_missing", userId, "system", {});
    return new Map();
  }
  trackEvent("ms_presence.batch_fetched", userId, "system", { count: result.size });
  return result;
}

/**
 * Fetch the caller's own presence. Returns null on 401/403/404/error.
 * Emits `ms_presence.scope_missing` on 401/403.
 */
export async function getOwnPresence(
  userMsToken: string,
  userId: string = "system",
): Promise<Presence | null> {
  try {
    const res = await fetch(`${GRAPH_BASE_URL}/me/presence`, {
      headers: {
        Authorization: `Bearer ${userMsToken}`,
        Accept: "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) {
      trackEvent("ms_presence.scope_missing", userId, "system", {});
      return null;
    }
    if (!res.ok) return null;
    const data = (await res.json()) as RawPresence;
    const p = normalizePresence(data, data.id || "");
    trackEvent("ms_presence.batch_fetched", userId, "system", { count: 1 });
    return p;
  } catch (err) {
    console.warn(`[ms-graph-presence] own presence error:`, (err as Error).message);
    return null;
  }
}
