/**
 * Microsoft Graph typed delta client (L0) — Tier 3 Batch U1.
 *
 * This module is the thin, typed Graph surface used by the canonical-
 * mirror sync workers in `./sync/*.ts`. It is deliberately narrow: every
 * helper here performs one delta-enabled GET against a single Graph
 * endpoint and normalizes the shape to `{ items, nextDeltaLink }`.
 *
 * Reference implementation: `src/lib/integrations/microsoft-channel-messages.ts`
 * (channel-messages integration). That file is STREAM-EXCLUSIVE to another
 * owner and stays as-is. We re-implement the same token-refresh, 429
 * retry-after, and 403 scope-missing patterns here so the two surfaces
 * evolve independently.
 *
 * Scopes required (delegated):
 *   Calendars.Read              →  listCalendarEventsDelta
 *   Tasks.ReadWrite             →  listTasksDelta
 *   Mail.Read                   →  listMailDelta
 *   Contacts.Read               →  listContactsDelta
 *   Files.Read.All              →  listFilesDelta
 *
 * When admin consent has NOT yet been granted for the scope (token
 * missing it), Graph returns 403. We surface that as GraphClientError
 * with `code = "scope_missing"` so sync workers can emit a graceful
 * analytics event and return a typed { error, errorCode } — never throw
 * up to the caller. Same pattern as `asScopeMissing` in channel-messages.
 *
 * Rate limits: Graph 429 Retry-After is honored once per call, capped
 * at 60s. If the retry also fails, GraphClientError.code="rate_limited"
 * bubbles with `retryAfter` seconds so the worker can emit
 * `ms_sync.rate_limited`.
 *
 * Token refresh: `getValidToken` in `@/lib/microsoft-graph` already auto-
 * refreshes 5 minutes before expiry. If it returns null (refresh failed
 * or user not connected), we throw GraphClientError.code="no_token".
 */
 

import { getValidToken } from "@/lib/microsoft-graph";

// ---------------------------------------------------------------------------
// Constants + errors
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MAX_RETRY_AFTER_MS = 60 * 1000;

/**
 * Canonical error class for all Graph client operations. Every code path
 * that fails for a well-known reason surfaces as one of the string `code`
 * values so workers can pattern-match without string-scraping messages.
 */
export class GraphClientError extends Error {
  constructor(
    public status: number,
    public code:
      | "no_token"
      | "scope_missing"
      | "rate_limited"
      | "not_found"
      | "unauthorized"
      | "graph_error"
      | "network_error",
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = "GraphClientError";
  }
}

// ---------------------------------------------------------------------------
// Public response shape — uniform across all delta helpers
// ---------------------------------------------------------------------------

export interface DeltaResponse<T> {
  /** Items returned by this page of the delta feed. May be empty. */
  items: T[];
  /**
   * The `@odata.deltaLink` URL from the final page of this delta query.
   * Persist this to `instinct_ms_sync_cursors` and pass it back on the
   * next call to receive only the changes since this sync. Undefined
   * when the feed returned a nextLink (more pages) — our helpers follow
   * all nextLinks within a single call and return the deltaLink only
   * after the cursor is fully drained.
   */
  nextDeltaLink?: string;
}

// ---------------------------------------------------------------------------
// Internal: token + fetch helpers (mirrors channel-messages pattern)
// ---------------------------------------------------------------------------

async function resolveAccessToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) {
    throw new GraphClientError(
      401,
      "no_token",
      `No valid Microsoft token for user ${userId}`,
    );
  }
  return tok.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * GET a Graph endpoint with token, honoring 429 Retry-After once and
 * classifying 401/403/429/404/5xx into typed codes.
 */
async function graphGet<T = unknown>(
  endpointOrUrl: string,
  accessToken: string,
): Promise<T> {
  const url = endpointOrUrl.startsWith("http")
    ? endpointOrUrl
    : `${GRAPH_BASE_URL}/${endpointOrUrl}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers });
  } catch (err) {
    throw new GraphClientError(
      0,
      "network_error",
      `Graph GET ${endpointOrUrl} failed: ${(err as Error).message}`,
    );
  }

  if (res.status === 429) {
    const raRaw = parseInt(res.headers.get("Retry-After") || "0", 10);
    const raSec = Number.isFinite(raRaw) && raRaw > 0 ? raRaw : 1;
    const raMs = Math.min(raSec * 1000, MAX_RETRY_AFTER_MS);
    await sleep(raMs);
    let retry: Response;
    try {
      retry = await fetch(url, { method: "GET", headers });
    } catch (err) {
      throw new GraphClientError(
        0,
        "network_error",
        `Graph GET ${endpointOrUrl} failed on retry: ${(err as Error).message}`,
        raSec,
      );
    }
    if (retry.status === 429) {
      throw new GraphClientError(
        429,
        "rate_limited",
        `Graph GET ${endpointOrUrl} rate-limited after retry`,
        raSec,
      );
    }
    if (!retry.ok) {
      return classifyError<T>(retry, endpointOrUrl);
    }
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    return classifyError<T>(res, endpointOrUrl);
  }

  return (await res.json()) as T;
}

async function classifyError<T>(
  res: Response,
  endpoint: string,
): Promise<T> {
  const body = await safeText(res);
  if (res.status === 401) {
    throw new GraphClientError(
      401,
      "unauthorized",
      `Graph GET ${endpoint} unauthorized: ${body}`,
    );
  }
  if (res.status === 403) {
    throw new GraphClientError(
      403,
      "scope_missing",
      `Graph GET ${endpoint} forbidden (scope_missing): ${body}`,
    );
  }
  if (res.status === 404) {
    throw new GraphClientError(
      404,
      "not_found",
      `Graph GET ${endpoint} not found: ${body}`,
    );
  }
  throw new GraphClientError(
    res.status,
    "graph_error",
    `Graph GET ${endpoint} failed: ${res.status} ${body}`,
  );
}

/**
 * Drain a delta feed: follow every `@odata.nextLink` until the response
 * contains `@odata.deltaLink`, accumulating `value` along the way.
 *
 * `initialUrl` may be either a relative endpoint string (first sync —
 * no prior delta), a stored deltaLink URL (incremental sync), or a
 * full absolute URL.
 */
async function drainDeltaFeed<T>(
  initialUrl: string,
  accessToken: string,
): Promise<DeltaResponse<T>> {
  const items: T[] = [];
  let cursor: string | undefined = initialUrl;

  while (cursor) {
    type DeltaPage = {
      value?: T[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };
    const page: DeltaPage = await graphGet<DeltaPage>(cursor, accessToken);

    if (Array.isArray(page.value)) {
      items.push(...page.value);
    }

    if (page["@odata.deltaLink"]) {
      return { items, nextDeltaLink: page["@odata.deltaLink"] };
    }
    cursor = page["@odata.nextLink"];
  }

  // Feed drained without a deltaLink — Graph should always provide one
  // on terminal page of a `/delta` endpoint, so this is a defensive
  // fallback. Sync workers will retry next tick starting from scratch.
  return { items };
}

// ---------------------------------------------------------------------------
// Public delta helpers — one per entity type
// ---------------------------------------------------------------------------

/** Graph calendar event shape (only the fields we mirror). */
export interface GraphCalendarEvent {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  start?: { dateTime?: string | null; timeZone?: string | null };
  end?: { dateTime?: string | null; timeZone?: string | null };
  attendees?: Array<{
    emailAddress?: { name?: string | null; address?: string | null };
    type?: string | null;
  }>;
  organizer?: { emailAddress?: { address?: string | null } };
  isOnlineMeeting?: boolean | null;
  lastModifiedDateTime?: string | null;
  createdDateTime?: string | null;
  "@removed"?: { reason?: string } | null;
  [k: string]: unknown;
}

/** Graph To-Do task shape (fields we mirror). */
export interface GraphTask {
  id: string;
  title?: string | null;
  body?: { content?: string | null; contentType?: string | null };
  status?: string | null;
  importance?: string | null;
  dueDateTime?: { dateTime?: string | null; timeZone?: string | null } | null;
  createdDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  "@removed"?: { reason?: string } | null;
  [k: string]: unknown;
}

/** Graph mail message shape (fields we mirror). */
export interface GraphMailMessage {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  from?: { emailAddress?: { name?: string | null; address?: string | null } };
  toRecipients?: Array<{
    emailAddress?: { name?: string | null; address?: string | null };
  }>;
  hasAttachments?: boolean | null;
  receivedDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  "@removed"?: { reason?: string } | null;
  [k: string]: unknown;
}

/** Graph contact shape (fields we mirror). */
export interface GraphContact {
  id: string;
  displayName?: string | null;
  emailAddresses?: Array<{ address?: string | null; name?: string | null }>;
  companyName?: string | null;
  jobTitle?: string | null;
  createdDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  "@removed"?: { reason?: string } | null;
  [k: string]: unknown;
}

/** Graph drive-item shape (fields we mirror). */
export interface GraphDriveItem {
  id: string;
  name?: string | null;
  webUrl?: string | null;
  size?: number | null;
  file?: { mimeType?: string | null } | null;
  folder?: { childCount?: number } | null;
  parentReference?: { driveId?: string | null; path?: string | null };
  createdDateTime?: string | null;
  lastModifiedDateTime?: string | null;
  "@removed"?: { reason?: string } | null;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// listCalendarEventsDelta
// ---------------------------------------------------------------------------

/**
 * List calendar event changes since `deltaLink`. Initial call (no
 * deltaLink) returns ALL events in the next 180 days and emits a
 * deltaLink for incremental follow-up.
 *
 * Graph endpoint: GET /me/calendarview/delta
 *   Query: startDateTime / endDateTime required on first call; subsequent
 *   calls use the stored deltaLink unchanged.
 */
export async function listCalendarEventsDelta(
  userId: string,
  deltaLink?: string,
): Promise<DeltaResponse<GraphCalendarEvent>> {
  const token = await resolveAccessToken(userId);
  const initialUrl = deltaLink ?? buildInitialCalendarDelta();
  return drainDeltaFeed<GraphCalendarEvent>(initialUrl, token);
}

function buildInitialCalendarDelta(): string {
  const now = new Date();
  const startIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const endIso = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    startDateTime: startIso,
    endDateTime: endIso,
  });
  return `me/calendarview/delta?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// listTasksDelta
// ---------------------------------------------------------------------------

/**
 * List To-Do task changes. To-Do delta works at the *list* level
 * (/me/todo/lists/{id}/tasks/delta). We aggregate across every task
 * list the user has so the worker sees one flat stream.
 *
 * Note: the `deltaLink` returned by this helper is a composite JSON
 * string so the mapping {list_id → per-list-deltaLink} round-trips
 * cleanly through our single-column cursor storage. The worker stores
 * and passes it back opaquely.
 */
export async function listTasksDelta(
  userId: string,
  deltaLink?: string,
): Promise<DeltaResponse<GraphTask>> {
  const token = await resolveAccessToken(userId);

  let listsMap: Record<string, string | null> | null = null;
  if (deltaLink) {
    try {
      listsMap = JSON.parse(deltaLink) as Record<string, string | null>;
    } catch {
      listsMap = null; // fall through to list-discovery on parse failure
    }
  }

  // Discover all task lists on first sync (or when stored cursor is
  // unparseable). This is a simple non-delta GET — low cost, runs once
  // per worker tick.
  if (!listsMap) {
    const lists = await graphGet<{ value?: Array<{ id: string }> }>(
      "me/todo/lists",
      token,
    );
    listsMap = {};
    for (const l of lists.value ?? []) {
      listsMap[l.id] = null;
    }
  }

  const items: GraphTask[] = [];
  const nextMap: Record<string, string | null> = {};

  for (const [listId, listDeltaLink] of Object.entries(listsMap)) {
    const initial =
      listDeltaLink ??
      `me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`;
    try {
      const page = await drainDeltaFeed<GraphTask>(initial, token);
      items.push(...page.items);
      nextMap[listId] = page.nextDeltaLink ?? null;
    } catch (err) {
      // A single list disappearing (404) should not fail the whole
      // sync — drop it from the cursor map so next tick re-discovers.
      if (err instanceof GraphClientError && err.code === "not_found") {
        continue;
      }
      throw err;
    }
  }

  return { items, nextDeltaLink: JSON.stringify(nextMap) };
}

// ---------------------------------------------------------------------------
// listMailDelta
// ---------------------------------------------------------------------------

/**
 * List inbox message changes. Graph endpoint:
 *   GET /me/mailFolders/inbox/messages/delta
 *
 * We scope to inbox on purpose — this is the user's "incoming" surface
 * for the assistant's context. Other folders (Sent, Archive) can be
 * added later by extending the worker, not this helper.
 */
export async function listMailDelta(
  userId: string,
  deltaLink?: string,
): Promise<DeltaResponse<GraphMailMessage>> {
  const token = await resolveAccessToken(userId);
  const initialUrl =
    deltaLink ??
    "me/mailFolders/inbox/messages/delta?$select=id,subject,bodyPreview,from,toRecipients,hasAttachments,receivedDateTime,lastModifiedDateTime";
  return drainDeltaFeed<GraphMailMessage>(initialUrl, token);
}

// ---------------------------------------------------------------------------
// listContactsDelta
// ---------------------------------------------------------------------------

/**
 * List Outlook contact changes. Graph endpoint:
 *   GET /me/contacts/delta
 */
export async function listContactsDelta(
  userId: string,
  deltaLink?: string,
): Promise<DeltaResponse<GraphContact>> {
  const token = await resolveAccessToken(userId);
  const initialUrl = deltaLink ?? "me/contacts/delta";
  return drainDeltaFeed<GraphContact>(initialUrl, token);
}

// ---------------------------------------------------------------------------
// listFilesDelta
// ---------------------------------------------------------------------------

/**
 * List drive item changes. Graph endpoint:
 *   GET /me/drive/root/delta        (default, OneDrive)
 *   GET /drives/{driveId}/root/delta (shared / Teams drives)
 *
 * `driveId` is optional — omit for the user's OneDrive. The worker may
 * iterate over additional drives in a future extension.
 */
export async function listFilesDelta(
  userId: string,
  driveId?: string,
  deltaLink?: string,
): Promise<DeltaResponse<GraphDriveItem>> {
  const token = await resolveAccessToken(userId);
  const initialUrl =
    deltaLink ??
    (driveId
      ? `drives/${encodeURIComponent(driveId)}/root/delta`
      : "me/drive/root/delta");
  return drainDeltaFeed<GraphDriveItem>(initialUrl, token);
}

// ---------------------------------------------------------------------------
// Utility: classify a graph error for analytics + return shape
// ---------------------------------------------------------------------------

/**
 * Extract the shape sync workers need for analytics: the stable `code`
 * string, the HTTP status, and (when 429) the retry-after seconds.
 * Defined here so every worker uses identical shapes without importing
 * the error class individually.
 */
export function describeGraphError(err: unknown): {
  code: GraphClientError["code"] | "unknown";
  status: number;
  retryAfter?: number;
  message: string;
} {
  if (err instanceof GraphClientError) {
    return {
      code: err.code,
      status: err.status,
      retryAfter: err.retryAfter,
      message: err.message,
    };
  }
  return {
    code: "unknown",
    status: 0,
    message: (err as Error)?.message ?? String(err),
  };
}
