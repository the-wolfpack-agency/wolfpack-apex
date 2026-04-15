/**
 * Microsoft 365 Tasks (Microsoft To Do) integration.
 *
 * Builds on the existing `@/lib/microsoft-graph` OAuth + token storage.
 * All reads in the app are served from the local Postgres cache
 * (instinct_task_lists + instinct_tasks) — Graph is the source of truth
 * via write-through on mutations and webhook-driven re-sync.
 *
 * Graph surface:
 *   GET  /me/todo/lists
 *   GET  /me/todo/lists/{id}/tasks
 *   POST /me/todo/lists/{id}/tasks
 *   PATCH /me/todo/lists/{id}/tasks/{id}
 *
 * Rate limits: Graph returns 429 with Retry-After — honor it exactly once,
 * then surface. 5xx does not invalidate cached reads.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "notStarted"
  | "inProgress"
  | "completed"
  | "waitingOnOthers"
  | "deferred";

export type TaskImportance = "low" | "normal" | "high";

export interface MsTaskList {
  id: string; // local UUID
  msListId: string; // Graph id
  userId: string;
  displayName: string;
  isOwner: boolean;
  isShared: boolean;
  etag: string | null;
  syncedAt: string;
}

export interface MsTask {
  id: string; // local UUID
  msTaskId: string; // Graph id
  userId: string;
  listId: string; // local list UUID
  title: string;
  body: string | null;
  status: TaskStatus;
  importance: TaskImportance;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  etag: string | null;
  syncedAt: string;
  payload: Record<string, unknown>;
}

export interface CreateTaskInput {
  title: string;
  body?: string;
  dueAt?: string | null;
  importance?: TaskImportance;
}

export interface UpdateTaskInput {
  title?: string;
  body?: string;
  dueAt?: string | null;
  importance?: TaskImportance;
  status?: TaskStatus;
}

export interface ListTasksOpts {
  status?: TaskStatus;
  top?: number;
  skip?: number;
}

export interface SyncResult {
  listCount: number;
  taskCount: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Graph helpers — tasks-specific (own wrapper so we can honor Retry-After
// and return raw errors instead of swallowing them).
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

export class GraphTasksError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
    this.name = "GraphTasksError";
  }
}

async function graphCall<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: string,
  accessToken: string,
  body?: unknown,
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // 429: honor Retry-After exactly once, then re-throw on repeat.
  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    const retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 1;
    await sleep(retryAfter * 1000);
    const retry = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!retry.ok) {
      throw new GraphTasksError(retry.status, `Graph ${method} ${endpoint} failed after retry: ${retry.status}`, retryAfter);
    }
    if (retry.status === 204) return undefined as unknown as T;
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    const text = await safeText(res);
    throw new GraphTasksError(res.status, `Graph ${method} ${endpoint} failed: ${res.status} ${text}`);
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return ""; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveToken(userId: string): Promise<string> {
  const tok = await getValidToken(userId);
  if (!tok) throw new GraphTasksError(401, "No valid Microsoft token for user");
  return tok.accessToken;
}

// ---------------------------------------------------------------------------
// Normalization — Graph shape → our shape
// ---------------------------------------------------------------------------

interface GraphList {
  id: string;
  displayName: string;
  isOwner?: boolean;
  isShared?: boolean;
  "@odata.etag"?: string;
}

interface GraphTask {
  id: string;
  title: string;
  body?: { content?: string; contentType?: string };
  status: TaskStatus;
  importance?: TaskImportance;
  dueDateTime?: { dateTime: string; timeZone: string } | null;
  completedDateTime?: { dateTime: string; timeZone: string } | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  "@odata.etag"?: string;
  [k: string]: unknown;
}

function parseGraphDateTime(dt: { dateTime: string; timeZone?: string } | null | undefined): string | null {
  if (!dt || !dt.dateTime) return null;
  // Graph returns "2026-04-15T17:00:00.0000000" without Z; treat as UTC when
  // timezone is UTC (the default), otherwise fall back to letting Date parse it.
  const raw = dt.dateTime;
  if (dt.timeZone && dt.timeZone.toUpperCase() === "UTC") {
    const d = new Date(raw.endsWith("Z") ? raw : raw + "Z");
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// Cache upserts
// ---------------------------------------------------------------------------

async function upsertList(userId: string, g: GraphList): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_task_lists (user_id, ms_list_id, display_name, is_owner, is_shared, etag, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id, ms_list_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       is_owner = EXCLUDED.is_owner,
       is_shared = EXCLUDED.is_shared,
       etag = EXCLUDED.etag,
       synced_at = now()
     RETURNING id`,
    [userId, g.id, g.displayName, g.isOwner ?? true, g.isShared ?? false, g["@odata.etag"] ?? null],
  );
  return rows[0].id;
}

async function upsertTask(userId: string, listUuid: string, g: GraphTask): Promise<string> {
  const bodyContent = g.body?.content ?? null;
  const dueAt = parseGraphDateTime(g.dueDateTime ?? null);
  const completedAt = parseGraphDateTime(g.completedDateTime ?? null);
  const createdAt = g.createdDateTime ? new Date(g.createdDateTime).toISOString() : new Date().toISOString();
  const updatedAt = g.lastModifiedDateTime ? new Date(g.lastModifiedDateTime).toISOString() : new Date().toISOString();

  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_tasks
       (user_id, ms_task_id, list_id, title, body, status, importance, due_at, completed_at,
        created_at, updated_at, etag, synced_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13)
     ON CONFLICT (user_id, ms_task_id) DO UPDATE SET
       list_id = EXCLUDED.list_id,
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       status = EXCLUDED.status,
       importance = EXCLUDED.importance,
       due_at = EXCLUDED.due_at,
       completed_at = EXCLUDED.completed_at,
       updated_at = EXCLUDED.updated_at,
       etag = EXCLUDED.etag,
       synced_at = now(),
       payload = EXCLUDED.payload
     RETURNING id`,
    [
      userId,
      g.id,
      listUuid,
      g.title,
      bodyContent,
      g.status,
      g.importance ?? "normal",
      dueAt,
      completedAt,
      createdAt,
      updatedAt,
      g["@odata.etag"] ?? null,
      JSON.stringify(g),
    ],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List the caller's task lists. Reads from Graph directly — this is a
 * write-through refresh helper, not the dashboard read path (use
 * listCachedTaskLists for that).
 */
export async function listTaskLists(userId: string): Promise<GraphList[]> {
  const token = await resolveToken(userId);
  const res = await graphCall<{ value: GraphList[] }>("GET", "me/todo/lists", token);
  return res.value ?? [];
}

/**
 * List tasks in a given Graph list. Supports $top/$skip paging and
 * optional status filter. Graph returns a max of 1000 per page.
 */
export async function listTasks(
  userId: string,
  msListId: string,
  opts: ListTasksOpts = {},
): Promise<GraphTask[]> {
  const token = await resolveToken(userId);
  const params = new URLSearchParams();
  if (opts.top) params.set("$top", String(opts.top));
  if (opts.skip) params.set("$skip", String(opts.skip));
  if (opts.status) params.set("$filter", `status eq '${opts.status}'`);
  const qs = params.toString();
  const endpoint = `me/todo/lists/${encodeURIComponent(msListId)}/tasks${qs ? "?" + qs : ""}`;
  const res = await graphCall<{ value: GraphTask[] }>("GET", endpoint, token);
  return res.value ?? [];
}

/**
 * Create a task in the given list via Graph POST, then write-through to
 * the local cache. Returns the cached MsTask.
 */
export async function createTask(
  userId: string,
  msListId: string,
  input: CreateTaskInput,
): Promise<MsTask> {
  const token = await resolveToken(userId);
  const body: Record<string, unknown> = {
    title: input.title,
    importance: input.importance ?? "normal",
  };
  if (input.body) body.body = { content: input.body, contentType: "text" };
  if (input.dueAt) body.dueDateTime = { dateTime: input.dueAt, timeZone: "UTC" };

  const created = await graphCall<GraphTask>(
    "POST",
    `me/todo/lists/${encodeURIComponent(msListId)}/tasks`,
    token,
    body,
  );

  // Write-through: ensure list exists in cache, then upsert the task.
  const listUuid = await ensureListInCache(userId, msListId);
  const localId = await upsertTask(userId, listUuid, created);
  const cached = await getCachedTaskById(userId, localId);
  if (!cached) throw new GraphTasksError(500, "Cache upsert did not return row");

  trackEvent("system.task_created", userId, "system", {
    task_id: cached.msTaskId,
    list_id: msListId,
    via: "instinct",
  });
  return cached;
}

/**
 * Update a task via Graph PATCH + local cache update.
 */
export async function updateTask(
  userId: string,
  msListId: string,
  msTaskId: string,
  patch: UpdateTaskInput,
): Promise<MsTask> {
  const token = await resolveToken(userId);
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.importance !== undefined) body.importance = patch.importance;
  if (patch.body !== undefined) body.body = { content: patch.body, contentType: "text" };
  if (patch.dueAt !== undefined) {
    body.dueDateTime = patch.dueAt ? { dateTime: patch.dueAt, timeZone: "UTC" } : null;
  }

  const updated = await graphCall<GraphTask>(
    "PATCH",
    `me/todo/lists/${encodeURIComponent(msListId)}/tasks/${encodeURIComponent(msTaskId)}`,
    token,
    body,
  );

  const listUuid = await ensureListInCache(userId, msListId);
  const localId = await upsertTask(userId, listUuid, updated);
  const cached = await getCachedTaskById(userId, localId);
  if (!cached) throw new GraphTasksError(500, "Cache upsert did not return row");
  return cached;
}

/**
 * Convenience — mark a task completed. Emits analytics.
 */
export async function completeTask(
  userId: string,
  msListId: string,
  msTaskId: string,
  via: "instinct" | "ms_todo" = "instinct",
): Promise<MsTask> {
  const start = Date.now();
  const cached = await updateTask(userId, msListId, msTaskId, { status: "completed" });
  trackEvent("system.task_completed", userId, "system", {
    task_id: msTaskId,
    via,
    duration_ms: Date.now() - start,
  });
  return cached;
}

/**
 * Full sync — pulls every list + every task for the user and upserts
 * into local cache. Intended for first login, webhook refresh, and a
 * future periodic scheduler. Idempotent — calling twice is safe.
 */
export async function syncAllForUser(userId: string): Promise<SyncResult> {
  const start = Date.now();
  try {
    const lists = await listTaskLists(userId);
    let taskCount = 0;
    for (const list of lists) {
      const listUuid = await upsertList(userId, list);
      // Page through tasks; Graph caps at 1000 per page.
      let skip = 0;
      const top = 100;
      // Safety bound — stop after 100 pages (10k tasks/list).
      for (let page = 0; page < 100; page++) {
        const tasks = await listTasks(userId, list.id, { top, skip });
        for (const t of tasks) {
          await upsertTask(userId, listUuid, t);
          taskCount++;
        }
        if (tasks.length < top) break;
        skip += top;
      }
    }
    const durationMs = Date.now() - start;
    trackEvent("system.ms_tasks_synced", userId, "system", {
      user_id: userId,
      list_count: lists.length,
      task_count: taskCount,
      duration_ms: durationMs,
    });
    return { listCount: lists.length, taskCount, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const status = err instanceof GraphTasksError ? err.status : 0;
    trackEvent("system.ms_tasks_sync_failed", userId, "system", {
      user_id: userId,
      error: (err as Error).message,
      http_status: status,
      duration_ms: durationMs,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cache read helpers
// ---------------------------------------------------------------------------

export async function listCachedTaskLists(userId: string): Promise<MsTaskList[]> {
  const { rows } = await safeQuery<{
    id: string; user_id: string; ms_list_id: string; display_name: string;
    is_owner: boolean; is_shared: boolean; etag: string | null; synced_at: string;
  }>(
    `SELECT id, user_id, ms_list_id, display_name, is_owner, is_shared, etag, synced_at
     FROM instinct_task_lists
     WHERE user_id = $1
     ORDER BY display_name ASC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    msListId: r.ms_list_id,
    displayName: r.display_name,
    isOwner: r.is_owner,
    isShared: r.is_shared,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  }));
}

export interface ListCachedTasksOpts {
  status?: TaskStatus;
  listId?: string; // local UUID OR ms list id (we accept both)
  dueBefore?: string;
  dueAfter?: string;
  search?: string;
  limit?: number;
  cursor?: string; // task UUID offset
}

export async function listCachedTasks(
  userId: string,
  opts: ListCachedTasksOpts = {},
): Promise<{ tasks: MsTask[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId];
  const conds: string[] = ["t.user_id = $1"];

  if (opts.status) {
    params.push(opts.status);
    conds.push(`t.status = $${params.length}`);
  }
  if (opts.listId) {
    // Accept either local UUID or ms_list_id.
    if (/^[0-9a-f-]{36}$/i.test(opts.listId)) {
      params.push(opts.listId);
      conds.push(`t.list_id = $${params.length}`);
    } else {
      params.push(opts.listId);
      conds.push(`l.ms_list_id = $${params.length}`);
    }
  }
  if (opts.dueBefore) {
    params.push(opts.dueBefore);
    conds.push(`t.due_at IS NOT NULL AND t.due_at <= $${params.length}`);
  }
  if (opts.dueAfter) {
    params.push(opts.dueAfter);
    conds.push(`t.due_at IS NOT NULL AND t.due_at >= $${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    const p = params.length;
    conds.push(`(t.title ILIKE $${p} OR t.body ILIKE $${p})`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conds.push(`t.id > $${params.length}`);
  }
  params.push(limit + 1);

  const sql = `
    SELECT t.*, l.ms_list_id AS list_ms_id
    FROM instinct_tasks t
    JOIN instinct_task_lists l ON l.id = t.list_id
    WHERE ${conds.join(" AND ")}
    ORDER BY t.due_at ASC NULLS LAST, t.updated_at DESC, t.id ASC
    LIMIT $${params.length}
  `;
  const { rows } = await safeQuery<any>(sql, params);

  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const tasks: MsTask[] = taken.map(rowToTask);
  const nextCursor = hasMore ? tasks[tasks.length - 1].id : null;
  return { tasks, nextCursor };
}

export async function getCachedTaskById(userId: string, localId: string): Promise<MsTask | null> {
  const { rows } = await safeQuery<any>(
    `SELECT t.*, l.ms_list_id AS list_ms_id
     FROM instinct_tasks t
     JOIN instinct_task_lists l ON l.id = t.list_id
     WHERE t.user_id = $1 AND t.id = $2
     LIMIT 1`,
    [userId, localId],
  );
  if (rows.length === 0) return null;
  return rowToTask(rows[0]);
}

export async function getCachedTaskByMsId(userId: string, msTaskId: string): Promise<MsTask | null> {
  const { rows } = await safeQuery<any>(
    `SELECT t.*, l.ms_list_id AS list_ms_id
     FROM instinct_tasks t
     JOIN instinct_task_lists l ON l.id = t.list_id
     WHERE t.user_id = $1 AND t.ms_task_id = $2
     LIMIT 1`,
    [userId, msTaskId],
  );
  if (rows.length === 0) return null;
  return rowToTask(rows[0]);
}

function rowToTask(r: any): MsTask {
  return {
    id: r.id,
    msTaskId: r.ms_task_id,
    userId: r.user_id,
    listId: r.list_id,
    title: r.title,
    body: r.body,
    status: r.status,
    importance: r.importance,
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : (r.payload ?? {}),
  };
}

async function ensureListInCache(userId: string, msListId: string): Promise<string> {
  const { rows } = await safeQuery<{ id: string }>(
    `SELECT id FROM instinct_task_lists WHERE user_id = $1 AND ms_list_id = $2 LIMIT 1`,
    [userId, msListId],
  );
  if (rows.length > 0) return rows[0].id;
  // List not cached yet — fetch the shell from Graph to get displayName.
  try {
    const token = await resolveToken(userId);
    const list = await graphCall<GraphList>("GET", `me/todo/lists/${encodeURIComponent(msListId)}`, token);
    return upsertList(userId, list);
  } catch {
    // Fall back to a placeholder row so writes still succeed.
    return upsertList(userId, { id: msListId, displayName: "(unknown)", isOwner: true, isShared: false });
  }
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

/**
 * Validate the clientState header sent by Graph against the expected
 * secret (MS_TASKS_WEBHOOK_CLIENT_STATE). Returns true if either the
 * header matches or no secret is configured (shadow/dev).
 */
export function verifyWebhookClientState(received: string | null): boolean {
  const expected = process.env.MS_TASKS_WEBHOOK_CLIENT_STATE;
  if (!expected) return true;
  if (!received) return false;
  // Constant-time compare
  if (received.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }
  return mismatch === 0;
}
