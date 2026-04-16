/**
 * Microsoft 365 Groups integration (Tier 2 · Stream D).
 *
 * Provides read access to the caller's Group memberships — the backbone
 * for Planner (team tasks), Teams channels, shared Outlook resources.
 *
 * Scope: Group.Read.All (admin-consent required).
 *
 * On 403 we return a discriminated `scope_missing` result instead of
 * throwing — the caller's Microsoft connection is valid, the app just
 * wasn't granted the scope. This mirrors the pattern used by
 * microsoft-mail.ts / microsoft-calendar.ts.
 *
 * Graph surface:
 *   GET /me/memberOf/microsoft.graph.group
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GroupsErrorCode =
  | "not_connected"
  | "scope_missing"
  | "rate_limited"
  | "graph_error"
  | "internal";

export interface GroupsErrorResult {
  ok: false;
  code: GroupsErrorCode;
  scope?: string;
  retryAfter?: number;
  status?: number;
  message?: string;
}

export interface GroupsOkResult<T> {
  ok: true;
  value: T;
}

export type GroupsResult<T> = GroupsOkResult<T> | GroupsErrorResult;

export interface InstinctGroup {
  id: string; // local UUID
  userId: string;
  msGroupId: string;
  displayName: string;
  description: string | null;
  mailEnabled: boolean;
  groupTypes: string[];
  visibility: string | null;
  createdAt: string | null;
  syncedAt: string;
}

export interface ListGroupsOpts {
  limit?: number;
  cursor?: string;
  search?: string;
}

export interface SyncGroupsResult {
  count: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const REQUIRED_SCOPE = "Group.Read.All";

interface GraphGroup {
  id: string;
  displayName?: string;
  description?: string;
  mailEnabled?: boolean;
  groupTypes?: string[];
  visibility?: string;
  createdDateTime?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeJson(res: Response): Promise<any | null> {
  try { return await res.json(); } catch { return null; }
}

function classify403(body: any): { code: GroupsErrorCode; message: string } {
  const errCode = body?.error?.code || body?.error?.innerError?.code || "";
  const errMsg = body?.error?.message || "forbidden";
  const isScope =
    /AccessDenied/i.test(String(errCode)) ||
    /Authorization_RequestDenied/i.test(String(errCode)) ||
    /scope/i.test(errMsg) ||
    /permission/i.test(errMsg);
  if (isScope) return { code: "scope_missing", message: errMsg };
  return { code: "graph_error", message: errMsg };
}

async function graphGet<T = unknown>(
  endpoint: string,
  accessToken: string,
): Promise<GroupsResult<T>> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;

  const doCall = () =>
    fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

  let res: Response;
  try {
    res = await doCall();
  } catch (err) {
    return { ok: false, code: "internal", message: `network_error: ${(err as Error).message}` };
  }

  // 429 with one-shot Retry-After honor.
  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 1;
    await sleep(retryAfter * 1000);
    try {
      res = await doCall();
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        retryAfter,
        message: `network_error_after_retry: ${(err as Error).message}`,
      };
    }
    if (res.status === 429) {
      return { ok: false, code: "rate_limited", status: 429, retryAfter, message: "rate_limited_after_retry" };
    }
  }

  if (res.status === 401) {
    return { ok: false, code: "not_connected", status: 401, message: "microsoft_not_connected" };
  }

  if (res.status === 403) {
    const body = await safeJson(res);
    const c = classify403(body);
    return { ok: false, code: c.code, status: 403, scope: REQUIRED_SCOPE, message: c.message };
  }

  if (!res.ok) {
    const body = await safeJson(res);
    return {
      ok: false,
      code: "graph_error",
      status: res.status,
      message: `graph_${res.status}: ${body?.error?.message ?? "unknown"}`,
    };
  }

  const data = (await safeJson(res)) as T | null;
  return { ok: true, value: (data ?? ({} as T)) };
}

async function resolveTokenOrError(
  userId: string,
): Promise<{ ok: true; token: string } | GroupsErrorResult> {
  const tok = await getValidToken(userId);
  if (!tok) return { ok: false, code: "not_connected", message: "no_valid_token" };
  return { ok: true, token: tok.accessToken };
}

// ---------------------------------------------------------------------------
// Cache upsert
// ---------------------------------------------------------------------------

async function upsertGroup(userId: string, g: GraphGroup): Promise<string> {
  const createdAt = g.createdDateTime ? new Date(g.createdDateTime).toISOString() : null;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_groups
       (user_id, ms_group_id, display_name, description, mail_enabled, group_types, visibility, created_at, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())
     ON CONFLICT (user_id, ms_group_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       mail_enabled = EXCLUDED.mail_enabled,
       group_types = EXCLUDED.group_types,
       visibility = EXCLUDED.visibility,
       created_at = COALESCE(EXCLUDED.created_at, instinct_groups.created_at),
       synced_at = now()
     RETURNING id`,
    [
      userId,
      g.id,
      g.displayName ?? "",
      g.description ?? null,
      g.mailEnabled ?? false,
      JSON.stringify(g.groupTypes ?? []),
      g.visibility ?? null,
      createdAt,
    ],
  );
  return rows[0].id;
}

function rowToGroup(r: any): InstinctGroup {
  return {
    id: r.id,
    userId: r.user_id,
    msGroupId: r.ms_group_id,
    displayName: r.display_name,
    description: r.description,
    mailEnabled: r.mail_enabled,
    groupTypes: typeof r.group_types === "string" ? JSON.parse(r.group_types) : (r.group_types ?? []),
    visibility: r.visibility,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API — cache reads
// ---------------------------------------------------------------------------

/**
 * List caller's groups from local cache. Cache is the read path; call
 * `syncGroups` to refresh it.
 */
export async function listMyGroups(
  userId: string,
  opts: ListGroupsOpts = {},
): Promise<{ groups: InstinctGroup[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId];
  const conds: string[] = ["user_id = $1"];

  if (opts.search) {
    params.push(`%${opts.search}%`);
    conds.push(`display_name ILIKE $${params.length}`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conds.push(`id > $${params.length}`);
  }
  params.push(limit + 1);

  const sql = `SELECT id, user_id, ms_group_id, display_name, description,
                      mail_enabled, group_types, visibility, created_at, synced_at
                 FROM instinct_groups
                WHERE ${conds.join(" AND ")}
                ORDER BY display_name ASC, id ASC
                LIMIT $${params.length}`;
  const { rows } = await safeQuery<any>(sql, params);
  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const groups = taken.map(rowToGroup);
  return { groups, nextCursor: hasMore ? groups[groups.length - 1].id : null };
}

export async function getGroupByLocalId(userId: string, id: string): Promise<InstinctGroup | null> {
  const { rows } = await safeQuery<any>(
    `SELECT id, user_id, ms_group_id, display_name, description, mail_enabled,
            group_types, visibility, created_at, synced_at
       FROM instinct_groups
      WHERE user_id = $1 AND id = $2
      LIMIT 1`,
    [userId, id],
  );
  if (rows.length === 0) return null;
  return rowToGroup(rows[0]);
}

// ---------------------------------------------------------------------------
// Public API — sync (Graph → cache)
// ---------------------------------------------------------------------------

/**
 * Pull the caller's group memberships from Graph and upsert into cache.
 * Returns a count + duration. On 403 emits analytics + returns the
 * scope_missing result (never throws).
 */
export async function syncGroups(
  userId: string,
): Promise<GroupsResult<SyncGroupsResult>> {
  const start = Date.now();
  const tokRes = await resolveTokenOrError(userId);
  if (!tokRes.ok) {
    trackEvent("system.ms_groups_sync_failed", userId, "system", {
      user_id: userId,
      code: tokRes.code,
      duration_ms: Date.now() - start,
    });
    return tokRes;
  }

  // /me/memberOf with OData cast to only return groups (not DirectoryRoles).
  // $select keeps the payload small; $top=100 is the Graph default max.
  const endpoint =
    "me/memberOf/microsoft.graph.group?$select=id,displayName,description," +
    "mailEnabled,groupTypes,visibility,createdDateTime&$top=100";

  let count = 0;
  let next: string | null = endpoint;

  // Safety bound — 50 pages = 5,000 groups.
  for (let page = 0; page < 50 && next; page++) {
    const res: GroupsResult<{ value?: GraphGroup[]; "@odata.nextLink"?: string }> =
      await graphGet(next, tokRes.token);
    if (!res.ok) {
      trackEvent("system.ms_groups_sync_failed", userId, "system", {
        user_id: userId,
        code: res.code,
        http_status: res.status ?? 0,
        duration_ms: Date.now() - start,
      });
      return res;
    }
    const groups = res.value.value ?? [];
    for (const g of groups) {
      try {
        await upsertGroup(userId, g);
        count++;
      } catch (err) {
        // Never lose data on a single bad row; log + continue.
        console.warn("[microsoft-groups] upsert failed:", (err as Error).message);
      }
    }
    next = res.value["@odata.nextLink"] ?? null;
  }

  const durationMs = Date.now() - start;
  trackEvent("system.ms_groups_synced", userId, "system", {
    user_id: userId,
    count,
    duration_ms: durationMs,
  });
  return { ok: true, value: { count, durationMs } };
}
