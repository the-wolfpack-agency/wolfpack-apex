/**
 * Microsoft 365 tenant directory (all users) — Tier 2 · Stream B.
 *
 * Surface:
 *   listUsers       — list cached users with optional search/department
 *                     filter (cache-first; Graph only during sync).
 *   getUser         — detail by ms_user_id or userPrincipalName (cache hit
 *                     fast-path; cache-miss triggers Graph fetch + upsert).
 *   getManager      — /users/{id}/manager.
 *   getDirectReports — /users/{id}/directReports.
 *   syncDirectory   — delta sync via /users/delta, idempotent upserts.
 *
 * Graph surface used:
 *   GET /users/delta?$select=...
 *   GET /users/{id or upn}
 *   GET /users/{id}/manager
 *   GET /users/{id}/directReports
 *
 * Delta token is persisted in `instinct_ms_sync_state(scope='directory_users')`
 * so subsequent syncs only pull changed rows. Full resync happens naturally
 * when we seed the first token.
 *
 * Scopes consumed: `User.Read.All` (flagged to Stream D for MS_SCOPES
 * inclusion). On 403 helpers return a structured scope_missing result
 * rather than throwing.
 *
 * Privacy note: we do NOT cache mailbox settings, photos, or device data
 * here — only the public-directory fields. Mailbox OOO lives in
 * src/lib/integrations/microsoft-mailbox.ts and targets /me only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DirectoryUser {
  id: string; // local UUID
  msUserId: string;
  userPrincipalName: string | null;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  mail: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  businessPhones: string[];
  mobilePhone: string | null;
  managerMsId: string | null;
  accountEnabled: boolean;
  onPremisesSyncEnabled: boolean | null;
  createdAt: string | null;
  etag: string | null;
  syncedAt: string;
}

export interface ListUsersOpts {
  top?: number;
  cursor?: string; // local id cursor (for cached reads)
  search?: string;
  department?: string;
}

export interface SyncOpts {
  deltaToken?: string;
}

export interface SyncResult {
  synced: number;
  durationMs: number;
  nextDeltaToken?: string;
}

export type ScopeMissingResult = {
  ok: false;
  code: "scope_missing";
  scope: string;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DirectoryError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
    this.name = "DirectoryError";
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MAX_RETRY_AFTER_MS = 60 * 1000;
const USER_SELECT =
  "id,userPrincipalName,displayName,givenName,surname,mail,jobTitle,department," +
  "officeLocation,businessPhones,mobilePhone,accountEnabled,onPremisesSyncEnabled,createdDateTime";

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new DirectoryError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

async function graphGet<T = unknown>(endpoint: string, accessToken: string): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const res = await fetch(url, { method: "GET", headers });

  if (res.status === 429) {
    const raRaw = parseInt(res.headers.get("Retry-After") || "0", 10);
    const raMs = Math.min(
      Number.isFinite(raRaw) && raRaw > 0 ? raRaw * 1000 : 1000,
      MAX_RETRY_AFTER_MS,
    );
    await sleep(raMs);
    const retry = await fetch(url, { method: "GET", headers });
    if (!retry.ok) {
      throw new DirectoryError(
        retry.status,
        `Graph GET ${endpoint} failed after retry: ${retry.status}`,
        Math.ceil(raMs / 1000),
      );
    }
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new DirectoryError(res.status, `Graph GET ${endpoint} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface GraphUser {
  id: string;
  userPrincipalName?: string | null;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  mail?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  businessPhones?: string[] | null;
  mobilePhone?: string | null;
  accountEnabled?: boolean | null;
  onPremisesSyncEnabled?: boolean | null;
  createdDateTime?: string | null;
  "@odata.etag"?: string;
  "@removed"?: { reason?: string };
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string") as string[];
}

function rowToUser(r: any): DirectoryUser {
  const phones =
    typeof r.business_phones === "string"
      ? JSON.parse(r.business_phones)
      : r.business_phones ?? [];
  return {
    id: r.id,
    msUserId: r.ms_user_id,
    userPrincipalName: r.user_principal_name ?? null,
    displayName: r.display_name ?? null,
    givenName: r.given_name ?? null,
    surname: r.surname ?? null,
    mail: r.mail ?? null,
    jobTitle: r.job_title ?? null,
    department: r.department ?? null,
    officeLocation: r.office_location ?? null,
    businessPhones: Array.isArray(phones) ? phones : [],
    mobilePhone: r.mobile_phone ?? null,
    managerMsId: r.manager_ms_id ?? null,
    accountEnabled: Boolean(r.account_enabled ?? true),
    onPremisesSyncEnabled:
      r.on_premises_sync_enabled === null || r.on_premises_sync_enabled === undefined
        ? null
        : Boolean(r.on_premises_sync_enabled),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    etag: r.etag ?? null,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cache upsert
// ---------------------------------------------------------------------------

async function upsertDirectoryUser(g: GraphUser, managerMsId?: string | null): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_directory_users
       (ms_user_id, user_principal_name, display_name, given_name, surname,
        mail, job_title, department, office_location, business_phones,
        mobile_phone, manager_ms_id, account_enabled, on_premises_sync_enabled,
        created_at, etag, synced_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
             $11, $12, $13, $14, $15, $16, now(), $17::jsonb)
     ON CONFLICT (ms_user_id) DO UPDATE SET
       user_principal_name      = EXCLUDED.user_principal_name,
       display_name             = EXCLUDED.display_name,
       given_name               = EXCLUDED.given_name,
       surname                  = EXCLUDED.surname,
       mail                     = EXCLUDED.mail,
       job_title                = EXCLUDED.job_title,
       department               = EXCLUDED.department,
       office_location          = EXCLUDED.office_location,
       business_phones          = EXCLUDED.business_phones,
       mobile_phone             = EXCLUDED.mobile_phone,
       manager_ms_id            = COALESCE(EXCLUDED.manager_ms_id, instinct_directory_users.manager_ms_id),
       account_enabled          = EXCLUDED.account_enabled,
       on_premises_sync_enabled = EXCLUDED.on_premises_sync_enabled,
       created_at               = COALESCE(EXCLUDED.created_at, instinct_directory_users.created_at),
       etag                     = EXCLUDED.etag,
       synced_at                = now(),
       payload                  = EXCLUDED.payload
     RETURNING id`,
    [
      g.id,
      g.userPrincipalName ?? null,
      g.displayName ?? null,
      g.givenName ?? null,
      g.surname ?? null,
      g.mail ?? null,
      g.jobTitle ?? null,
      g.department ?? null,
      g.officeLocation ?? null,
      JSON.stringify(coerceStringArray(g.businessPhones)),
      g.mobilePhone ?? null,
      managerMsId ?? null,
      g.accountEnabled ?? true,
      g.onPremisesSyncEnabled ?? null,
      g.createdDateTime ? new Date(g.createdDateTime).toISOString() : null,
      g["@odata.etag"] ?? null,
      JSON.stringify(g),
    ],
  );
  return rows[0].id;
}

async function deleteDirectoryUser(msUserId: string): Promise<void> {
  await query(`DELETE FROM instinct_directory_users WHERE ms_user_id = $1`, [msUserId]);
}

// ---------------------------------------------------------------------------
// Delta-token persistence
// ---------------------------------------------------------------------------

const DELTA_SCOPE = "directory_users";

async function loadDeltaToken(): Promise<string | null> {
  const { rows } = await safeQuery<{ delta_token: string | null }>(
    `SELECT delta_token FROM instinct_ms_sync_state WHERE scope = $1 LIMIT 1`,
    [DELTA_SCOPE],
  );
  return rows.length > 0 ? rows[0].delta_token : null;
}

async function persistDeltaToken(token: string | null): Promise<void> {
  if (!token) return;
  await query(
    `INSERT INTO instinct_ms_sync_state (scope, delta_token, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (scope) DO UPDATE SET
       delta_token = EXCLUDED.delta_token,
       updated_at = now()`,
    [DELTA_SCOPE, token],
  );
}

function extractDeltaToken(link: string | undefined): string | undefined {
  if (!link) return undefined;
  try {
    const u = new URL(link);
    return u.searchParams.get("$deltatoken") ?? u.searchParams.get("$deltaToken") ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List cached directory users. `search` matches display_name / job_title /
 * department via trigram ILIKE. `department` is an exact filter.
 * Pagination cursor is the local UUID (stable ordering).
 */
export async function listUsers(
  userId: string,
  opts: ListUsersOpts = {},
): Promise<{ users: DirectoryUser[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.top ?? 50, 1), 200);

  const conds: string[] = ["account_enabled = true"];
  const params: unknown[] = [];
  let i = 1;

  if (opts.search) {
    const term = `%${opts.search}%`;
    conds.push(
      `(coalesce(display_name, '') ILIKE $${i} ` +
      `OR coalesce(job_title, '') ILIKE $${i} ` +
      `OR coalesce(department, '') ILIKE $${i} ` +
      `OR coalesce(user_principal_name, '') ILIKE $${i} ` +
      `OR coalesce(mail, '') ILIKE $${i})`,
    );
    params.push(term);
    i++;
  }
  if (opts.department) {
    conds.push(`department = $${i}`);
    params.push(opts.department);
    i++;
  }
  if (opts.cursor) {
    conds.push(`id > $${i}`);
    params.push(opts.cursor);
    i++;
  }
  params.push(limit + 1);
  const limitParam = `$${i}`;

  const { rows } = await safeQuery<any>(
    `SELECT id, ms_user_id, user_principal_name, display_name, given_name, surname,
            mail, job_title, department, office_location, business_phones,
            mobile_phone, manager_ms_id, account_enabled, on_premises_sync_enabled,
            created_at, etag, synced_at
       FROM instinct_directory_users
       WHERE ${conds.join(" AND ")}
       ORDER BY coalesce(display_name, user_principal_name, ms_user_id) ASC, id ASC
       LIMIT ${limitParam}`,
    params,
  );

  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const users = taken.map(rowToUser);
  const nextCursor = hasMore ? users[users.length - 1].id : null;

  trackEvent("system.ms_directory_user_fetched", userId, "system", {
    mode: "list",
    count: users.length,
    has_search: opts.search ? 1 : 0,
  });

  return { users, nextCursor };
}

/**
 * Get one user by Graph id OR userPrincipalName. Cache-first.
 * On miss, fetches from Graph and upserts.
 */
export async function getUser(
  userId: string,
  idOrUpn: string,
): Promise<DirectoryUser | null> {
  // Cache lookup — try both id and UPN.
  const cached = await safeQuery<any>(
    `SELECT id, ms_user_id, user_principal_name, display_name, given_name, surname,
            mail, job_title, department, office_location, business_phones,
            mobile_phone, manager_ms_id, account_enabled, on_premises_sync_enabled,
            created_at, etag, synced_at
       FROM instinct_directory_users
       WHERE ms_user_id = $1 OR user_principal_name = $1
       LIMIT 1`,
    [idOrUpn],
  );

  if (cached.rows.length > 0) {
    trackEvent("system.ms_directory_user_fetched", userId, "system", {
      mode: "cache_hit",
      identifier: idOrUpn.slice(0, 64),
    });
    return rowToUser(cached.rows[0]);
  }

  // Cache miss — fetch from Graph.
  let token: string;
  try {
    token = await resolveToken(userId);
  } catch (err) {
    if (err instanceof DirectoryError && err.status === 401) return null;
    throw err;
  }

  try {
    const g = await graphGet<GraphUser>(
      `users/${encodeURIComponent(idOrUpn)}?$select=${USER_SELECT}`,
      token,
    );
    await upsertDirectoryUser(g);
    trackEvent("system.ms_directory_user_fetched", userId, "system", {
      mode: "cache_miss_fetched",
      ms_user_id: g.id,
    });
    // Re-read so we return the canonical row shape.
    const fresh = await safeQuery<any>(
      `SELECT id, ms_user_id, user_principal_name, display_name, given_name, surname,
              mail, job_title, department, office_location, business_phones,
              mobile_phone, manager_ms_id, account_enabled, on_premises_sync_enabled,
              created_at, etag, synced_at
         FROM instinct_directory_users
         WHERE ms_user_id = $1
         LIMIT 1`,
      [g.id],
    );
    return fresh.rows.length > 0 ? rowToUser(fresh.rows[0]) : null;
  } catch (err) {
    if (err instanceof DirectoryError && err.status === 404) return null;
    if (err instanceof DirectoryError && err.status === 403) {
      trackEvent("system.ms_directory_user_fetched", userId, "system", {
        mode: "scope_missing",
      });
      return null;
    }
    throw err;
  }
}

/**
 * Get a user's manager. Caches the manager row + writes
 * manager_ms_id back onto the subject so repeat lookups hit the cache.
 */
export async function getManager(
  userId: string,
  msUserId: string,
): Promise<DirectoryUser | null> {
  let token: string;
  try {
    token = await resolveToken(userId);
  } catch (err) {
    if (err instanceof DirectoryError && err.status === 401) return null;
    throw err;
  }

  try {
    const g = await graphGet<GraphUser>(
      `users/${encodeURIComponent(msUserId)}/manager?$select=${USER_SELECT}`,
      token,
    );
    if (!g || !g.id) return null;
    await upsertDirectoryUser(g);
    // Patch the subject's manager_ms_id.
    await query(
      `UPDATE instinct_directory_users
         SET manager_ms_id = $2, synced_at = now()
       WHERE ms_user_id = $1`,
      [msUserId, g.id],
    );
    const fresh = await safeQuery<any>(
      `SELECT id, ms_user_id, user_principal_name, display_name, given_name, surname,
              mail, job_title, department, office_location, business_phones,
              mobile_phone, manager_ms_id, account_enabled, on_premises_sync_enabled,
              created_at, etag, synced_at
         FROM instinct_directory_users
         WHERE ms_user_id = $1
         LIMIT 1`,
      [g.id],
    );
    return fresh.rows.length > 0 ? rowToUser(fresh.rows[0]) : null;
  } catch (err) {
    if (err instanceof DirectoryError && (err.status === 404 || err.status === 403)) return null;
    throw err;
  }
}

/**
 * Get a user's direct reports. Upserts each report + sets its
 * manager_ms_id to the subject.
 */
export async function getDirectReports(
  userId: string,
  msUserId: string,
): Promise<DirectoryUser[]> {
  let token: string;
  try {
    token = await resolveToken(userId);
  } catch (err) {
    if (err instanceof DirectoryError && err.status === 401) return [];
    throw err;
  }

  try {
    const page = await graphGet<{ value?: GraphUser[] }>(
      `users/${encodeURIComponent(msUserId)}/directReports?$select=${USER_SELECT}`,
      token,
    );
    const reports = page.value ?? [];
    const out: DirectoryUser[] = [];
    for (const r of reports) {
      if (!r.id) continue;
      await upsertDirectoryUser(r, msUserId);
      const fresh = await safeQuery<any>(
        `SELECT id, ms_user_id, user_principal_name, display_name, given_name, surname,
                mail, job_title, department, office_location, business_phones,
                mobile_phone, manager_ms_id, account_enabled, on_premises_sync_enabled,
                created_at, etag, synced_at
           FROM instinct_directory_users
           WHERE ms_user_id = $1
           LIMIT 1`,
        [r.id],
      );
      if (fresh.rows.length > 0) out.push(rowToUser(fresh.rows[0]));
    }
    return out;
  } catch (err) {
    if (err instanceof DirectoryError && (err.status === 404 || err.status === 403)) return [];
    throw err;
  }
}

/**
 * Delta-sync the tenant directory into `instinct_directory_users`.
 * Uses a persisted delta token so subsequent syncs are incremental.
 * On 403 returns `{ ok:false, code:"scope_missing", scope:"User.Read.All" }`.
 */
export async function syncDirectory(
  userId: string,
  opts: SyncOpts = {},
): Promise<SyncResult | ScopeMissingResult> {
  const start = Date.now();
  let token: string;
  try {
    token = await resolveToken(userId);
  } catch (err) {
    if (err instanceof DirectoryError && err.status === 401) {
      return { synced: 0, durationMs: Date.now() - start };
    }
    throw err;
  }

  const startToken = opts.deltaToken ?? (await loadDeltaToken());
  let nextEndpoint: string;
  if (startToken) {
    nextEndpoint = `users/delta?$deltatoken=${encodeURIComponent(startToken)}&$select=${USER_SELECT}`;
  } else {
    nextEndpoint = `users/delta?$select=${USER_SELECT}`;
  }

  let synced = 0;
  let lastDeltaLink: string | undefined;
  try {
    // Walk pages until we hit deltaLink (final page) or nextLink runs out.
    // Hard cap 100 pages to defend against runaway tenants.
    for (let page = 0; page < 100; page++) {
      const res = await graphGet<{
        value?: GraphUser[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      }>(nextEndpoint, token);

      const users = res.value ?? [];
      for (const u of users) {
        if (!u.id) continue;
        // Deletes: Graph marks with @removed.
        if (u["@removed"]) {
          await deleteDirectoryUser(u.id);
          continue;
        }
        await upsertDirectoryUser(u);
        synced++;
      }

      if (res["@odata.deltaLink"]) {
        lastDeltaLink = res["@odata.deltaLink"];
        break;
      }
      if (!res["@odata.nextLink"]) break;
      nextEndpoint = res["@odata.nextLink"];
    }

    const nextDeltaToken = extractDeltaToken(lastDeltaLink);
    if (nextDeltaToken) await persistDeltaToken(nextDeltaToken);

    const durationMs = Date.now() - start;
    trackEvent("system.ms_directory_synced", userId, "system", {
      synced,
      duration_ms: durationMs,
      had_previous_token: startToken ? 1 : 0,
    });
    return { synced, durationMs, nextDeltaToken };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (err instanceof DirectoryError && err.status === 403) {
      trackEvent("system.ms_directory_sync_failed", userId, "system", {
        reason: "scope_missing",
        duration_ms: durationMs,
      });
      return { ok: false, code: "scope_missing", scope: "User.Read.All" };
    }
    trackEvent("system.ms_directory_sync_failed", userId, "system", {
      error: (err as Error).message.slice(0, 200),
      http_status: err instanceof DirectoryError ? err.status : 0,
      duration_ms: durationMs,
    });
    throw err;
  }
}

/**
 * Translate a caught error into a scope_missing result, or null.
 * Mirrors microsoft-teams-chat.ts for route consistency.
 */
export function asScopeMissing(
  err: unknown,
  scope: string,
): ScopeMissingResult | null {
  if (err instanceof DirectoryError && err.status === 403) {
    return { ok: false, code: "scope_missing", scope };
  }
  return null;
}
