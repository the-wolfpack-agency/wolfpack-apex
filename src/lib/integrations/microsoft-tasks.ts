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
  startAt: string | null;
  reminderAt: string | null;
  isReminderOn: boolean;
  categories: string[];
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
  startAt?: string | null;
  reminderAt?: string | null;
  isReminderOn?: boolean;
  categories?: string[];
  importance?: TaskImportance;
}

export interface UpdateTaskInput {
  title?: string;
  body?: string;
  dueAt?: string | null;
  startAt?: string | null;
  reminderAt?: string | null;
  isReminderOn?: boolean;
  categories?: string[];
  importance?: TaskImportance;
  status?: TaskStatus;
}

export interface ListTasksOpts {
  status?: TaskStatus;
  top?: number;
  skip?: number;
}

/**
 * Validate the optional Outlook fields shared by the create + update routes.
 * Returns an error string (for a 400) or null when the shape is acceptable.
 * Kept here so both /api/tasks and /api/tasks/[id] validate identically (DRY).
 */
export function validateOutlookTaskFields(body: {
  dueAt?: string | null;
  startAt?: string | null;
  reminderAt?: string | null;
  isReminderOn?: boolean;
  categories?: string[];
}): string | null {
  for (const key of ["dueAt", "startAt", "reminderAt"] as const) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || isNaN(new Date(v).getTime())) {
      return `Invalid ${key}`;
    }
  }
  if (body.isReminderOn !== undefined && typeof body.isReminderOn !== "boolean") {
    return "Invalid isReminderOn";
  }
  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories) || body.categories.some((c) => typeof c !== "string")) {
      return "categories must be an array of strings";
    }
    if (body.categories.length > 50) return "too many categories";
  }
  return null;
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
  /** "none" | "defaultList" | "flaggedEmails". Marks the user's default list. */
  wellknownListName?: string;
  "@odata.etag"?: string;
}

interface GraphTask {
  id: string;
  title: string;
  body?: { content?: string; contentType?: string };
  status: TaskStatus;
  importance?: TaskImportance;
  dueDateTime?: { dateTime: string; timeZone: string } | null;
  startDateTime?: { dateTime: string; timeZone: string } | null;
  reminderDateTime?: { dateTime: string; timeZone: string } | null;
  isReminderOn?: boolean;
  categories?: string[];
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
  const startAt = parseGraphDateTime(g.startDateTime ?? null);
  const reminderAt = parseGraphDateTime(g.reminderDateTime ?? null);
  const isReminderOn = g.isReminderOn ?? false;
  const categories = Array.isArray(g.categories) ? g.categories.filter((c) => typeof c === "string") : [];
  const completedAt = parseGraphDateTime(g.completedDateTime ?? null);
  const createdAt = g.createdDateTime ? new Date(g.createdDateTime).toISOString() : new Date().toISOString();
  const updatedAt = g.lastModifiedDateTime ? new Date(g.lastModifiedDateTime).toISOString() : new Date().toISOString();

  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_tasks
       (user_id, ms_task_id, list_id, title, body, status, importance, due_at, start_at,
        reminder_at, is_reminder_on, categories, completed_at,
        created_at, updated_at, etag, synced_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, now(), $17)
     ON CONFLICT (user_id, ms_task_id) DO UPDATE SET
       list_id = EXCLUDED.list_id,
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       status = EXCLUDED.status,
       importance = EXCLUDED.importance,
       due_at = EXCLUDED.due_at,
       start_at = EXCLUDED.start_at,
       reminder_at = EXCLUDED.reminder_at,
       is_reminder_on = EXCLUDED.is_reminder_on,
       categories = EXCLUDED.categories,
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
      startAt,
      reminderAt,
      isReminderOn,
      JSON.stringify(categories),
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
 * Resolve the user's DEFAULT To Do list id so a task can be created without the
 * user having to pick a list. Microsoft To Do always has a default list
 * (wellknownListName "defaultList", usually shown as "Tasks"). We fetch the
 * lists from Graph, cache them (so the picker populates for next time), and
 * return the default list's Graph id, falling back to the first owned list.
 * Throws GraphTasksError(404) only if the account genuinely has no lists.
 */
export async function resolveDefaultListId(userId: string): Promise<string> {
  const lists = await listTaskLists(userId);
  if (lists.length === 0) {
    throw new GraphTasksError(404, "No Microsoft To Do lists found for this account");
  }
  // Best-effort cache warm so the "New task" list picker is populated afterward.
  for (const g of lists) {
    try {
      await upsertList(userId, g);
    } catch {
      /* caching is best-effort; never block task creation on it */
    }
  }
  const chosen =
    lists.find((l) => l.wellknownListName === "defaultList") ??
    lists.find((l) => l.isOwner) ??
    lists[0];
  return chosen.id;
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
  if (input.startAt) body.startDateTime = { dateTime: input.startAt, timeZone: "UTC" };
  if (input.reminderAt) {
    body.reminderDateTime = { dateTime: input.reminderAt, timeZone: "UTC" };
    // A reminder time implies the reminder is on unless explicitly disabled.
    body.isReminderOn = input.isReminderOn ?? true;
  } else if (input.isReminderOn !== undefined) {
    body.isReminderOn = input.isReminderOn;
  }
  if (input.categories !== undefined) {
    body.categories = input.categories.filter((c) => typeof c === "string" && c.trim().length > 0);
  }

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
  if (patch.startAt !== undefined) {
    body.startDateTime = patch.startAt ? { dateTime: patch.startAt, timeZone: "UTC" } : null;
  }
  if (patch.reminderAt !== undefined) {
    body.reminderDateTime = patch.reminderAt ? { dateTime: patch.reminderAt, timeZone: "UTC" } : null;
    body.isReminderOn = patch.reminderAt ? (patch.isReminderOn ?? true) : false;
  } else if (patch.isReminderOn !== undefined) {
    body.isReminderOn = patch.isReminderOn;
  }
  if (patch.categories !== undefined) {
    body.categories = patch.categories.filter((c) => typeof c === "string" && c.trim().length > 0);
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
 * DELETE a task — Graph DELETE + local cache delete.
 * Write-through: Graph first; on success, drop the cached row so
 * the UI reflects reality even if a subsequent sync is delayed.
 */
export async function deleteTask(
  userId: string,
  msListId: string,
  msTaskId: string,
): Promise<void> {
  const token = await resolveToken(userId);
  const start = Date.now();
  await graphCall<void>(
    "DELETE",
    `me/todo/lists/${encodeURIComponent(msListId)}/tasks/${encodeURIComponent(msTaskId)}`,
    token,
  );
  const { query } = await import("@/lib/db");
  await query(
    `DELETE FROM instinct_tasks WHERE user_id = $1 AND ms_task_id = $2`,
    [userId, msTaskId],
  );
  trackEvent("system.task_deleted" as never, userId, "system", {
    task_id: msTaskId,
    list_id: msListId,
    duration_ms: Date.now() - start,
  });
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

function normalizeCategories(raw: unknown): string[] {
  const arr = typeof raw === "string" ? safeParseArray(raw) : raw;
  if (!Array.isArray(arr)) return [];
  return arr.filter((c): c is string => typeof c === "string");
}

function safeParseArray(s: string): unknown {
  try { return JSON.parse(s); } catch { return []; }
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
    startAt: r.start_at ? new Date(r.start_at).toISOString() : null,
    reminderAt: r.reminder_at ? new Date(r.reminder_at).toISOString() : null,
    isReminderOn: r.is_reminder_on ?? false,
    categories: normalizeCategories(r.categories),
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

// ---------------------------------------------------------------------------
// Live reads
// ---------------------------------------------------------------------------

/**
 * The user's open tasks, read from Graph at question time.
 *
 * WHY THIS REPLACES THE CACHE READ. instinct_ms_tasks has never held a row in
 * production. The mirror is a write-behind cache with no writer: the sync
 * worker is well built, nothing schedules it, and its own docstring asks for a
 * poller that was never written. Every read returned [], and the assistant
 * reported that as "You have no open tasks. Nice."
 *
 * Rather than write the missing poller, this asks Microsoft. The answer is
 * always current, needs nothing synced first, is scoped by the user's own
 * delegated token, and leaves no copy of their task list in our database. One
 * fewer moving part, and the compliance story is simply that we do not hold it.
 *
 * FANS OUT ACROSS LISTS, BOUNDED. Graph has no "all my tasks" endpoint; tasks
 * belong to lists. So this lists the lists and gathers across them in parallel,
 * capped, because an account with forty lists must not turn one question into
 * forty sequential round trips.
 *
 * NEVER THROWS. Callers are chat tools and route handlers where a bad day at
 * Microsoft must degrade to a named reason, not a stack trace. The reason is
 * carried so a caller can tell "you have none" from "we could not ask", which
 * is the distinction the cache read could never make.
 */
export type LiveTasksResult =
  | { ok: true; tasks: MsTask[] }
  | { ok: false; reason: "not_connected" | "scope_missing" | "rate_limited" | "unavailable" };

/** Lists to fan out across. Beyond this the latency is worse than the value. */
const LIVE_LIST_CAP = 8;

function graphTaskToMsTask(userId: string, listId: string, g: GraphTask): MsTask {
  const iso = (d?: { dateTime: string } | null): string | null =>
    d?.dateTime ? new Date(d.dateTime).toISOString() : null;
  return {
    /* No local row exists, so the Graph id is the identity. Callers use it to
       open the task, which is the only thing the id is for here. */
    id: g.id,
    msTaskId: g.id,
    userId,
    listId,
    title: g.title,
    body: g.body?.content ?? null,
    status: g.status,
    importance: g.importance ?? "normal",
    dueAt: iso(g.dueDateTime),
    startAt: iso(g.startDateTime),
    reminderAt: iso(g.reminderDateTime),
    isReminderOn: Boolean(g.isReminderOn),
    categories: g.categories ?? [],
    completedAt: iso(g.completedDateTime),
    createdAt: g.createdDateTime ?? new Date(0).toISOString(),
    updatedAt: g.lastModifiedDateTime ?? new Date(0).toISOString(),
    etag: (g["@odata.etag"] as string | undefined) ?? null,
    /* Read live, so it is current as of now rather than as of a sync that
       never ran. Filling this with the read time is the truthful answer to
       "how fresh is this", not a placeholder. */
    syncedAt: new Date().toISOString(),
    payload: g as unknown as Record<string, unknown>,
  };
}

function liveFailureReason(err: unknown): LiveTasksResult {
  const status = err instanceof GraphTasksError ? err.status : 0;
  if (status === 401) return { ok: false, reason: "not_connected" };
  if (status === 403) return { ok: false, reason: "scope_missing" };
  if (status === 429) return { ok: false, reason: "rate_limited" };
  return { ok: false, reason: "unavailable" };
}

export async function listOpenTasksLive(
  userId: string,
  opts: { limit?: number } = {},
): Promise<LiveTasksResult> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  let lists: GraphList[];
  try {
    lists = await listTaskLists(userId);
  } catch (err) {
    return liveFailureReason(err);
  }

  /* No lists at all is a real, readable answer: the account exists and holds
     nothing. Distinct from a failure, and the caller may say so. */
  if (lists.length === 0) return { ok: true, tasks: [] };

  const settled = await Promise.allSettled(
    lists.slice(0, LIVE_LIST_CAP).map((l) =>
      listTasks(userId, l.id, { top: limit, status: "notStarted" }).then((tasks) =>
        tasks.map((t) => graphTaskToMsTask(userId, l.id, t)),
      ),
    ),
  );

  /* EVERY LIST FAILING IS A FAILURE; ONE FAILING IS NOT.
     Returning a partial list as though it were complete is how "you have two
     tasks" gets said to somebody who has nine. But refusing to answer because
     one list of eight was briefly unavailable would be worse than a slightly
     short list, so the distinction is all-or-some. */
  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  if (fulfilled.length === 0) {
    const firstErr = settled.find((s) => s.status === "rejected");
    return liveFailureReason(
      firstErr && firstErr.status === "rejected" ? firstErr.reason : undefined,
    );
  }

  const tasks = fulfilled
    .flatMap((s) => (s as PromiseFulfilledResult<MsTask[]>).value)
    .filter((t) => t.status !== "completed")
    /* Oldest due date first, undated last: the order somebody reads a to-do
       list in, rather than the order Graph happened to return lists. */
    .sort((a, b) => {
      if (!a.dueAt && !b.dueAt) return 0;
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      return Date.parse(a.dueAt) - Date.parse(b.dueAt);
    })
    .slice(0, limit);

  return { ok: true, tasks };
}
