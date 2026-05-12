/**
 * Microsoft Planner integration (Tier 2 · Stream D).
 *
 * Shared team tasks — complements Tier 1 personal To Do tasks
 * (src/lib/integrations/microsoft-tasks.ts). Plans can be backed by
 * either an M365 Group (most common) or a Planner Roster (plans
 * created outside of Groups).
 *
 * Scope: Tasks.ReadWrite.Shared + Group.Read.All for listing group plans.
 *
 * Cache-first reads (instinct_planner_*) — Graph is only hit on mutations
 * and explicit syncs. Graph etags are required for PATCH/DELETE; on
 * 412 (Precondition Failed) we re-fetch the task and return
 * { ok:false, code:"etag_conflict" } so the UI can retry with fresh etag.
 *
 * On 403 / 429 / 5xx we return discriminated results — never throw on
 * expected Graph failures.
 */
 

import { getValidToken } from "@/lib/microsoft-graph";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { notify } from "@/lib/notifications/in-app";
import { saveAnswer } from "@/lib/knowledge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlannerErrorCode =
  | "not_connected"
  | "scope_missing"
  | "rate_limited"
  | "etag_conflict"
  | "not_found"
  | "invalid_input"
  | "graph_error"
  | "internal";

export interface PlannerErrorResult {
  ok: false;
  code: PlannerErrorCode;
  scope?: string;
  retryAfter?: number;
  status?: number;
  message?: string;
}

export interface PlannerOkResult<T> {
  ok: true;
  value: T;
}

export type PlannerResult<T> = PlannerOkResult<T> | PlannerErrorResult;

export interface PlannerPlan {
  id: string; // local UUID
  userId: string;
  groupId: string | null; // local UUID
  msGroupId: string | null;
  msPlanId: string;
  msContainerId: string | null;
  msContainerType: "group" | "roster";
  title: string;
  createdBy: Record<string, unknown>;
  createdAt: string | null;
  etag: string | null;
  syncedAt: string;
}

export interface PlannerBucket {
  id: string;
  planId: string;
  msBucketId: string;
  name: string;
  orderHint: string | null;
  etag: string | null;
  syncedAt: string;
}

export interface PlannerTask {
  id: string;
  userId: string;
  planId: string;
  bucketId: string | null;
  msTaskId: string;
  title: string;
  dueAt: string | null;
  startAt: string | null;
  percentComplete: number;
  priority: number;
  assignees: string[];
  createdBy: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  etag: string | null;
  syncedAt: string;
  payload: Record<string, unknown>;
}

export interface CreateTaskInput {
  planId: string; // accepts local UUID OR Graph plan id
  bucketId?: string; // accepts local UUID OR Graph bucket id
  title: string;
  dueAt?: string | null;
  assignees?: string[];
  priority?: number;
}

export interface UpdateTaskPatch {
  title?: string;
  dueAt?: string | null;
  bucketId?: string | null;
  assignees?: string[];
  priority?: number;
  percentComplete?: number;
}

export interface ListTasksOpts {
  percentComplete?: number;
  assigneeUserId?: string; // Graph user id
  dueBefore?: string;
  dueAfter?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface SyncResult {
  planCount: number;
  bucketCount: number;
  taskCount: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const REQUIRED_SCOPE = "Tasks.ReadWrite.Shared";

interface GraphPlan {
  id: string;
  title?: string;
  container?: { containerId?: string; type?: string; url?: string };
  createdBy?: Record<string, unknown>;
  createdDateTime?: string;
  "@odata.etag"?: string;
}

interface GraphBucket {
  id: string;
  name?: string;
  planId?: string;
  orderHint?: string;
  "@odata.etag"?: string;
}

interface GraphTask {
  id: string;
  planId?: string;
  bucketId?: string;
  title?: string;
  percentComplete?: number;
  priority?: number;
  dueDateTime?: string | null;
  startDateTime?: string | null;
  createdBy?: Record<string, unknown>;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  completedDateTime?: string | null;
  assignments?: Record<string, unknown>;
  "@odata.etag"?: string;
  [k: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeJson(res: Response): Promise<any | null> {
  try { return await res.json(); } catch { return null; }
}

function classify403(body: any): { code: PlannerErrorCode; message: string } {
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

interface GraphCall<T> extends PlannerOkResult<T> {
  etag: string | null;
  headers?: Headers;
}

async function graphCall<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: string,
  accessToken: string,
  opts: { body?: unknown; ifMatch?: string } = {},
): Promise<GraphCall<T> | PlannerErrorResult> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;

  const doCall = () =>
    fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

  let res: Response;
  try {
    res = await doCall();
  } catch (err) {
    return { ok: false, code: "internal", message: `network_error: ${(err as Error).message}` };
  }

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
  if (res.status === 404) {
    return { ok: false, code: "not_found", status: 404, message: "graph_not_found" };
  }
  if (res.status === 412) {
    return { ok: false, code: "etag_conflict", status: 412, message: "etag_stale" };
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

  let data: T | null = null;
  if (res.status !== 204) {
    data = (await safeJson(res)) as T;
  }
  const etag = res.headers.get("ETag") || (data as any)?.["@odata.etag"] || null;
  return { ok: true, value: (data ?? ({} as T)), etag, headers: res.headers };
}

async function resolveTokenOrError(
  userId: string,
): Promise<{ ok: true; token: string } | PlannerErrorResult> {
  const tok = await getValidToken(userId);
  if (!tok) return { ok: false, code: "not_connected", message: "no_valid_token" };
  return { ok: true, token: tok.accessToken };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function parseIsoOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extractAssignees(assignments: Record<string, unknown> | undefined): string[] {
  if (!assignments) return [];
  // Graph shape: { [userId]: { ... } }
  return Object.keys(assignments);
}

function rowToPlan(r: any): PlannerPlan {
  return {
    id: r.id,
    userId: r.user_id,
    groupId: r.group_id,
    msGroupId: r.ms_group_id ?? null,
    msPlanId: r.ms_plan_id,
    msContainerId: r.ms_container_id,
    msContainerType: (r.ms_container_type ?? "group") as "group" | "roster",
    title: r.title,
    createdBy: typeof r.created_by === "string" ? JSON.parse(r.created_by) : (r.created_by ?? {}),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

function rowToBucket(r: any): PlannerBucket {
  return {
    id: r.id,
    planId: r.plan_id,
    msBucketId: r.ms_bucket_id,
    name: r.name,
    orderHint: r.order_hint,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
  };
}

function rowToTask(r: any): PlannerTask {
  return {
    id: r.id,
    userId: r.user_id,
    planId: r.plan_id,
    bucketId: r.bucket_id,
    msTaskId: r.ms_task_id,
    title: r.title,
    dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
    startAt: r.start_at ? new Date(r.start_at).toISOString() : null,
    percentComplete: Number(r.percent_complete ?? 0),
    priority: Number(r.priority ?? 5),
    assignees: typeof r.assignees === "string" ? JSON.parse(r.assignees) : (r.assignees ?? []),
    createdBy: typeof r.created_by === "string" ? JSON.parse(r.created_by) : (r.created_by ?? {}),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    etag: r.etag,
    syncedAt: new Date(r.synced_at).toISOString(),
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : (r.payload ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Cache upserts
// ---------------------------------------------------------------------------

async function upsertPlan(
  userId: string,
  g: GraphPlan,
  groupLocalId: string | null,
  containerType: "group" | "roster",
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_planner_plans
       (user_id, group_id, ms_plan_id, ms_container_id, ms_container_type, title,
        created_by, created_at, etag, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now())
     ON CONFLICT (user_id, ms_plan_id) DO UPDATE SET
       group_id = EXCLUDED.group_id,
       ms_container_id = EXCLUDED.ms_container_id,
       ms_container_type = EXCLUDED.ms_container_type,
       title = EXCLUDED.title,
       created_by = EXCLUDED.created_by,
       created_at = COALESCE(EXCLUDED.created_at, instinct_planner_plans.created_at),
       etag = EXCLUDED.etag,
       synced_at = now()
     RETURNING id`,
    [
      userId,
      groupLocalId,
      g.id,
      g.container?.containerId ?? null,
      containerType,
      g.title ?? "",
      JSON.stringify(g.createdBy ?? {}),
      parseIsoOrNull(g.createdDateTime),
      g["@odata.etag"] ?? null,
    ],
  );
  return rows[0].id;
}

async function upsertBucket(planLocalId: string, g: GraphBucket): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_planner_buckets
       (plan_id, ms_bucket_id, name, order_hint, etag, synced_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (ms_bucket_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       name = EXCLUDED.name,
       order_hint = EXCLUDED.order_hint,
       etag = EXCLUDED.etag,
       synced_at = now()
     RETURNING id`,
    [
      planLocalId,
      g.id,
      g.name ?? "",
      g.orderHint ?? null,
      g["@odata.etag"] ?? null,
    ],
  );
  return rows[0].id;
}

async function upsertTask(
  userId: string,
  planLocalId: string,
  bucketLocalId: string | null,
  g: GraphTask,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO instinct_planner_tasks
       (user_id, plan_id, bucket_id, ms_task_id, title, due_at, start_at,
        percent_complete, priority, assignees, created_by, created_at,
        updated_at, completed_at, etag, synced_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12,
             $13, $14, $15, now(), $16::jsonb)
     ON CONFLICT (user_id, ms_task_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       bucket_id = EXCLUDED.bucket_id,
       title = EXCLUDED.title,
       due_at = EXCLUDED.due_at,
       start_at = EXCLUDED.start_at,
       percent_complete = EXCLUDED.percent_complete,
       priority = EXCLUDED.priority,
       assignees = EXCLUDED.assignees,
       updated_at = EXCLUDED.updated_at,
       completed_at = EXCLUDED.completed_at,
       etag = EXCLUDED.etag,
       synced_at = now(),
       payload = EXCLUDED.payload
     RETURNING id`,
    [
      userId,
      planLocalId,
      bucketLocalId,
      g.id,
      g.title ?? "",
      parseIsoOrNull(g.dueDateTime ?? null),
      parseIsoOrNull(g.startDateTime ?? null),
      Math.min(100, Math.max(0, Number(g.percentComplete ?? 0))),
      Math.min(10, Math.max(0, Number(g.priority ?? 5))),
      JSON.stringify(extractAssignees(g.assignments)),
      JSON.stringify(g.createdBy ?? {}),
      parseIsoOrNull(g.createdDateTime),
      parseIsoOrNull(g.lastModifiedDateTime),
      parseIsoOrNull(g.completedDateTime ?? null),
      g["@odata.etag"] ?? null,
      JSON.stringify(g),
    ],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Lookup helpers — accept either local UUID or Graph id
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Microsoft Graph user-id allow-list for object-key injection guards. */
const PLANNER_USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolvePlanIds(
  userId: string,
  idOrMsId: string,
): Promise<{ localId: string; msPlanId: string } | null> {
  const col = UUID_RE.test(idOrMsId) ? "id" : "ms_plan_id";
  const { rows } = await safeQuery<{ id: string; ms_plan_id: string }>(
    `SELECT id, ms_plan_id FROM instinct_planner_plans
      WHERE user_id = $1 AND ${col} = $2
      LIMIT 1`,
    [userId, idOrMsId],
  );
  if (rows.length === 0) return null;
  return { localId: rows[0].id, msPlanId: rows[0].ms_plan_id };
}

async function resolveBucketIds(
  idOrMsId: string,
): Promise<{ localId: string; msBucketId: string } | null> {
  const col = UUID_RE.test(idOrMsId) ? "id" : "ms_bucket_id";
  const { rows } = await safeQuery<{ id: string; ms_bucket_id: string }>(
    `SELECT id, ms_bucket_id FROM instinct_planner_buckets WHERE ${col} = $1 LIMIT 1`,
    [idOrMsId],
  );
  if (rows.length === 0) return null;
  return { localId: rows[0].id, msBucketId: rows[0].ms_bucket_id };
}

async function lookupGroupLocalIdByMs(
  userId: string,
  msGroupId: string | null,
): Promise<string | null> {
  if (!msGroupId) return null;
  const { rows } = await safeQuery<{ id: string }>(
    `SELECT id FROM instinct_groups WHERE user_id = $1 AND ms_group_id = $2 LIMIT 1`,
    [userId, msGroupId],
  );
  return rows.length > 0 ? rows[0].id : null;
}

// ---------------------------------------------------------------------------
// Public API — listing
// ---------------------------------------------------------------------------

/**
 * Graph read-through: list Planner plans for a Group. Result is upserted
 * into cache before returning.
 */
export async function listPlansForGroup(
  userId: string,
  groupIdOrMsId: string,
): Promise<PlannerResult<PlannerPlan[]>> {
  const tok = await resolveTokenOrError(userId);
  if (!tok.ok) return tok;

  // Resolve the MS group id + local group id.
  let msGroupId: string;
  let groupLocalId: string | null = null;
  if (UUID_RE.test(groupIdOrMsId)) {
    const { rows } = await safeQuery<{ id: string; ms_group_id: string }>(
      `SELECT id, ms_group_id FROM instinct_groups WHERE user_id = $1 AND id = $2 LIMIT 1`,
      [userId, groupIdOrMsId],
    );
    if (rows.length === 0) return { ok: false, code: "not_found", message: "group_not_in_cache" };
    msGroupId = rows[0].ms_group_id;
    groupLocalId = rows[0].id;
  } else {
    msGroupId = groupIdOrMsId;
    groupLocalId = await lookupGroupLocalIdByMs(userId, msGroupId);
  }

  const res = await graphCall<{ value?: GraphPlan[] }>(
    "GET",
    `groups/${encodeURIComponent(msGroupId)}/planner/plans`,
    tok.token,
  );
  if (!res.ok) return res;

  const out: PlannerPlan[] = [];
  for (const p of res.value.value ?? []) {
    const localId = await upsertPlan(userId, p, groupLocalId, "group");
    const { rows } = await safeQuery<any>(
      `SELECT p.*, g.ms_group_id
         FROM instinct_planner_plans p
         LEFT JOIN instinct_groups g ON g.id = p.group_id
        WHERE p.id = $1 LIMIT 1`,
      [localId],
    );
    if (rows[0]) out.push(rowToPlan(rows[0]));
  }
  return { ok: true, value: out };
}

/**
 * List Roster plans (plans not backed by an M365 group). Fetched via
 * /me/planner/plans and filtered by container type.
 */
export async function listRosterPlans(userId: string): Promise<PlannerResult<PlannerPlan[]>> {
  const tok = await resolveTokenOrError(userId);
  if (!tok.ok) return tok;

  const res = await graphCall<{ value?: GraphPlan[] }>(
    "GET",
    "me/planner/plans",
    tok.token,
  );
  if (!res.ok) return res;

  const out: PlannerPlan[] = [];
  for (const p of res.value.value ?? []) {
    const type = (p.container?.type ?? "").toLowerCase() === "roster" ? "roster" : "group";
    if (type !== "roster") continue;
    const localId = await upsertPlan(userId, p, null, "roster");
    const { rows } = await safeQuery<any>(
      `SELECT p.*, NULL::TEXT AS ms_group_id
         FROM instinct_planner_plans p
        WHERE p.id = $1 LIMIT 1`,
      [localId],
    );
    if (rows[0]) out.push(rowToPlan(rows[0]));
  }
  return { ok: true, value: out };
}

/**
 * List all plans (cache): group plans + roster plans.
 */
export async function listCachedPlans(
  userId: string,
  opts: { groupId?: string } = {},
): Promise<PlannerPlan[]> {
  const params: unknown[] = [userId];
  const conds: string[] = ["p.user_id = $1"];
  if (opts.groupId) {
    if (UUID_RE.test(opts.groupId)) {
      params.push(opts.groupId);
      conds.push(`p.group_id = $${params.length}`);
    } else {
      params.push(opts.groupId);
      conds.push(`g.ms_group_id = $${params.length}`);
    }
  }
  const { rows } = await safeQuery<any>(
    `SELECT p.*, g.ms_group_id
       FROM instinct_planner_plans p
       LEFT JOIN instinct_groups g ON g.id = p.group_id
      WHERE ${conds.join(" AND ")}
      ORDER BY p.title ASC, p.id ASC`,
    params,
  );
  return rows.map(rowToPlan);
}

/**
 * List buckets for a plan (cache-first, Graph fallback on empty).
 */
export async function listBuckets(
  userId: string,
  planIdOrMsId: string,
): Promise<PlannerResult<PlannerBucket[]>> {
  const resolved = await resolvePlanIds(userId, planIdOrMsId);
  if (!resolved) return { ok: false, code: "not_found", message: "plan_not_in_cache" };

  // Cache read first.
  const { rows: cached } = await safeQuery<any>(
    `SELECT * FROM instinct_planner_buckets WHERE plan_id = $1 ORDER BY order_hint ASC, name ASC`,
    [resolved.localId],
  );
  if (cached.length > 0) {
    return { ok: true, value: cached.map(rowToBucket) };
  }

  // Cache miss → Graph.
  const tok = await resolveTokenOrError(userId);
  if (!tok.ok) return tok;
  const res = await graphCall<{ value?: GraphBucket[] }>(
    "GET",
    `planner/plans/${encodeURIComponent(resolved.msPlanId)}/buckets`,
    tok.token,
  );
  if (!res.ok) return res;
  const out: PlannerBucket[] = [];
  for (const b of res.value.value ?? []) {
    const localId = await upsertBucket(resolved.localId, b);
    out.push({
      id: localId,
      planId: resolved.localId,
      msBucketId: b.id,
      name: b.name ?? "",
      orderHint: b.orderHint ?? null,
      etag: b["@odata.etag"] ?? null,
      syncedAt: new Date().toISOString(),
    });
  }
  return { ok: true, value: out };
}

/**
 * Cache read — tasks for a plan with optional filters.
 */
export async function listTasks(
  userId: string,
  planIdOrMsId: string,
  opts: ListTasksOpts = {},
): Promise<PlannerResult<{ tasks: PlannerTask[]; nextCursor: string | null }>> {
  const resolved = await resolvePlanIds(userId, planIdOrMsId);
  if (!resolved) return { ok: false, code: "not_found", message: "plan_not_in_cache" };

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [userId, resolved.localId];
  const conds: string[] = ["user_id = $1", "plan_id = $2"];
  if (opts.percentComplete !== undefined) {
    params.push(opts.percentComplete);
    conds.push(`percent_complete = $${params.length}`);
  }
  if (opts.assigneeUserId) {
    params.push(JSON.stringify([opts.assigneeUserId]));
    conds.push(`assignees @> $${params.length}::jsonb`);
  }
  if (opts.dueBefore) {
    params.push(opts.dueBefore);
    conds.push(`due_at IS NOT NULL AND due_at <= $${params.length}`);
  }
  if (opts.dueAfter) {
    params.push(opts.dueAfter);
    conds.push(`due_at IS NOT NULL AND due_at >= $${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    conds.push(`title ILIKE $${params.length}`);
  }
  if (opts.cursor) {
    params.push(opts.cursor);
    conds.push(`id > $${params.length}`);
  }
  params.push(limit + 1);

  const sql = `SELECT * FROM instinct_planner_tasks
                WHERE ${conds.join(" AND ")}
                ORDER BY due_at ASC NULLS LAST, updated_at DESC, id ASC
                LIMIT $${params.length}`;
  const { rows } = await safeQuery<any>(sql, params);
  const hasMore = rows.length > limit;
  const taken = hasMore ? rows.slice(0, limit) : rows;
  const tasks = taken.map(rowToTask);
  const nextCursor = hasMore ? tasks[tasks.length - 1].id : null;
  return { ok: true, value: { tasks, nextCursor } };
}

/**
 * Get a single task (cache). Returns null if not found.
 */
export async function getTask(userId: string, taskIdOrMsId: string): Promise<PlannerTask | null> {
  const col = UUID_RE.test(taskIdOrMsId) ? "id" : "ms_task_id";
  const { rows } = await safeQuery<any>(
    `SELECT * FROM instinct_planner_tasks WHERE user_id = $1 AND ${col} = $2 LIMIT 1`,
    [userId, taskIdOrMsId],
  );
  if (rows.length === 0) return null;
  return rowToTask(rows[0]);
}

// ---------------------------------------------------------------------------
// Public API — mutations (write-through: Graph → cache)
// ---------------------------------------------------------------------------

/**
 * Create a Planner task. Graph POST /planner/tasks with planId + bucketId.
 * Upserts into cache + emits analytics + audit.
 */
export async function createTask(
  userId: string,
  userRole: string,
  input: CreateTaskInput,
): Promise<PlannerResult<{ id: string; task: PlannerTask }>> {
  if (!input.title || input.title.trim().length === 0) {
    return { ok: false, code: "invalid_input", message: "title_required" };
  }
  const tok = await resolveTokenOrError(userId);
  if (!tok.ok) return tok;

  const plan = await resolvePlanIds(userId, input.planId);
  if (!plan) return { ok: false, code: "not_found", message: "plan_not_in_cache" };

  let bucketLocalId: string | null = null;
  let msBucketId: string | null = null;
  if (input.bucketId) {
    const b = await resolveBucketIds(input.bucketId);
    if (!b) return { ok: false, code: "not_found", message: "bucket_not_in_cache" };
    bucketLocalId = b.localId;
    msBucketId = b.msBucketId;
  }

  const body: Record<string, unknown> = {
    planId: plan.msPlanId,
    title: input.title.trim(),
  };
  if (msBucketId) body.bucketId = msBucketId;
  if (typeof input.priority === "number") body.priority = input.priority;
  if (input.dueAt !== undefined && input.dueAt !== null) body.dueDateTime = input.dueAt;
  if (input.assignees && input.assignees.length > 0) {
    // CodeQL: js/remote-property-injection — only Graph user-ids
    // (UUIDs) may become object keys here so an attacker can't inject
    // `__proto__` or pollute the assignments map.
    const assignments: Record<string, unknown> = Object.create(null);
    for (const uid of input.assignees) {
      if (typeof uid !== "string" || !PLANNER_USER_ID_RE.test(uid)) continue;
      assignments[uid] = { "@odata.type": "#microsoft.graph.plannerAssignment", orderHint: " !" };
    }
    body.assignments = assignments;
  }

  const res = await graphCall<GraphTask>("POST", "planner/tasks", tok.token, { body });
  if (!res.ok) {
    trackEvent("system.ms_planner_sync_failed", userId, userRole, {
      user_id: userId,
      op: "create",
      code: res.code,
      http_status: res.status ?? 0,
    });
    return res;
  }

  const localId = await upsertTask(userId, plan.localId, bucketLocalId, res.value);
  const task = await getTaskByLocalId(userId, localId);
  if (!task) return { ok: false, code: "internal", message: "cache_upsert_failed" };

  trackEvent("system.ms_planner_task_created", userId, userRole, {
    task_id: task.msTaskId,
    plan_id: plan.msPlanId,
    bucket_id: msBucketId ?? "",
    via: "instinct",
  });
  await recordAudit({
    actor: { user_id: userId, role: userRole },
    action: "planner.task.created",
    resourceType: "planner_task",
    resourceId: task.msTaskId,
    afterState: { planId: plan.msPlanId, title: task.title, assignees: task.assignees },
  }).catch(() => undefined);

  // RAG hookup — learn task title + plan/bucket name only (no assignee PII).
  saveAnswer(
    `Planner task: ${task.title}`,
    `Task "${task.title}" in plan ${plan.msPlanId}`,
    "planner_task",
    userId,
  ).catch(() => undefined);

  return { ok: true, value: { id: task.msTaskId, task } };
}

async function getTaskByLocalId(userId: string, localId: string): Promise<PlannerTask | null> {
  const { rows } = await safeQuery<any>(
    `SELECT * FROM instinct_planner_tasks WHERE user_id = $1 AND id = $2 LIMIT 1`,
    [userId, localId],
  );
  if (rows.length === 0) return null;
  return rowToTask(rows[0]);
}

/**
 * Update a Planner task. Graph PATCH with If-Match: etag. On 412 we
 * re-fetch the task to refresh cache + return etag_conflict so the
 * caller can retry with the fresh etag from the cached row.
 */
export async function updateTask(
  userId: string,
  userRole: string,
  taskIdOrMsId: string,
  patch: UpdateTaskPatch,
  etag: string,
): Promise<PlannerResult<{ id: string; task: PlannerTask }>> {
  const existing = await getTask(userId, taskIdOrMsId);
  if (!existing) return { ok: false, code: "not_found", message: "task_not_in_cache" };

  const tok = await resolveTokenOrError(userId);
  if (!tok.ok) return tok;

  const before = {
    title: existing.title,
    dueAt: existing.dueAt,
    bucketId: existing.bucketId,
    assignees: existing.assignees,
    priority: existing.priority,
    percentComplete: existing.percentComplete,
  };

  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.percentComplete !== undefined) {
    body.percentComplete = Math.min(100, Math.max(0, patch.percentComplete));
  }
  if (patch.priority !== undefined) body.priority = patch.priority;
  if (patch.dueAt !== undefined) body.dueDateTime = patch.dueAt; // null clears
  if (patch.bucketId !== undefined) {
    if (patch.bucketId === null) {
      body.bucketId = null;
    } else {
      const b = await resolveBucketIds(patch.bucketId);
      if (!b) return { ok: false, code: "not_found", message: "bucket_not_in_cache" };
      body.bucketId = b.msBucketId;
    }
  }
  if (patch.assignees !== undefined) {
    // CodeQL: js/remote-property-injection — strict UUID allow-list.
    const assignments: Record<string, unknown> = Object.create(null);
    for (const uid of patch.assignees) {
      if (typeof uid !== "string" || !PLANNER_USER_ID_RE.test(uid)) continue;
      assignments[uid] = { "@odata.type": "#microsoft.graph.plannerAssignment", orderHint: " !" };
    }
    body.assignments = assignments;
  }

  const res = await graphCall<GraphTask>(
    "PATCH",
    `planner/tasks/${encodeURIComponent(existing.msTaskId)}`,
    tok.token,
    { body, ifMatch: etag },
  );

  if (!res.ok) {
    if (res.code === "etag_conflict") {
      // Re-fetch the task so the cache (and etag) are fresh for retry.
      const fresh = await graphCall<GraphTask>(
        "GET",
        `planner/tasks/${encodeURIComponent(existing.msTaskId)}`,
        tok.token,
      );
      if (fresh.ok) {
        await upsertTask(userId, existing.planId, existing.bucketId, fresh.value);
      }
    }
    trackEvent("system.ms_planner_sync_failed", userId, userRole, {
      user_id: userId,
      op: "update",
      code: res.code,
      http_status: res.status ?? 0,
    });
    return res;
  }

  // Graph PATCH returns 204 No Content — re-fetch to get the canonical row.
  const fresh = await graphCall<GraphTask>(
    "GET",
    `planner/tasks/${encodeURIComponent(existing.msTaskId)}`,
    tok.token,
  );
  const graphTask = fresh.ok ? fresh.value : { id: existing.msTaskId, ...body } as GraphTask;
  const localId = await upsertTask(userId, existing.planId, existing.bucketId, graphTask);
  const task = await getTaskByLocalId(userId, localId);
  if (!task) return { ok: false, code: "internal", message: "cache_upsert_failed" };

  trackEvent("system.ms_planner_task_updated", userId, userRole, {
    task_id: task.msTaskId,
    plan_id: task.planId,
  });
  await recordAudit({
    actor: { user_id: userId, role: userRole },
    action: "planner.task.updated",
    resourceType: "planner_task",
    resourceId: task.msTaskId,
    beforeState: before,
    afterState: {
      title: task.title, dueAt: task.dueAt, bucketId: task.bucketId,
      assignees: task.assignees, priority: task.priority,
      percentComplete: task.percentComplete,
    },
  }).catch(() => undefined);

  return { ok: true, value: { id: task.msTaskId, task } };
}

/**
 * Mark a Planner task complete (percentComplete=100). Notifies the other
 * assignees so team visibility is preserved.
 */
export async function completeTask(
  userId: string,
  userRole: string,
  taskIdOrMsId: string,
  etag: string,
): Promise<PlannerResult<{ id: string; task: PlannerTask }>> {
  const existing = await getTask(userId, taskIdOrMsId);
  if (!existing) return { ok: false, code: "not_found", message: "task_not_in_cache" };

  const res = await updateTask(userId, userRole, taskIdOrMsId, { percentComplete: 100 }, etag);
  if (!res.ok) return res;

  trackEvent("system.ms_planner_task_completed", userId, userRole, {
    task_id: res.value.task.msTaskId,
    plan_id: res.value.task.planId,
  });

  // Notify the other assignees — the completer is excluded.
  const others = existing.assignees.filter((uid) => uid !== userId);
  for (const recipientId of others) {
    try {
      await notify({
        userId: recipientId,
        category: "tasks.completed",
        source: "planner",
        sourceId: existing.msTaskId,
        title: `Task completed: ${existing.title}`,
        body: `Completed by teammate`,
        actionUrl: `/planner?taskId=${existing.msTaskId}`,
        metadata: {
          planId: existing.planId,
          msTaskId: existing.msTaskId,
          completedBy: userId,
        },
        dedup: true,
      });
    } catch {
      // never throw on notify — keep the completion path green.
    }
  }

  return res;
}

// ---------------------------------------------------------------------------
// Public API — full sync
// ---------------------------------------------------------------------------

/**
 * Walk the caller's groups (from cache), list each group's plans,
 * each plan's buckets + tasks, and upsert. Also pulls roster plans.
 *
 * Idempotent — re-running just refreshes the cache.
 */
export async function syncAllForUser(
  userId: string,
  opts: { tasksPerPlan?: number } = {},
): Promise<PlannerResult<SyncResult>> {
  const start = Date.now();
  const tok = await resolveTokenOrError(userId);
  if (!tok.ok) {
    trackEvent("system.ms_planner_sync_failed", userId, "system", {
      user_id: userId,
      code: tok.code,
      duration_ms: Date.now() - start,
    });
    return tok;
  }

  const tasksPerPlan = Math.min(Math.max(opts.tasksPerPlan ?? 500, 1), 5000);

  let planCount = 0;
  let bucketCount = 0;
  let taskCount = 0;

  // Group-backed plans.
  const { rows: groupRows } = await safeQuery<{ id: string; ms_group_id: string }>(
    `SELECT id, ms_group_id FROM instinct_groups WHERE user_id = $1`,
    [userId],
  );

  for (const g of groupRows) {
    const plansRes = await graphCall<{ value?: GraphPlan[] }>(
      "GET",
      `groups/${encodeURIComponent(g.ms_group_id)}/planner/plans`,
      tok.token,
    );
    if (!plansRes.ok) {
      // Group without Planner provisioned returns 404 — skip, not fatal.
      if (plansRes.code === "not_found") continue;
      trackEvent("system.ms_planner_sync_failed", userId, "system", {
        user_id: userId,
        stage: "list_plans",
        code: plansRes.code,
        http_status: plansRes.status ?? 0,
        duration_ms: Date.now() - start,
      });
      return plansRes;
    }

    for (const plan of plansRes.value.value ?? []) {
      const planLocalId = await upsertPlan(userId, plan, g.id, "group");
      planCount++;

      const bucketsRes = await graphCall<{ value?: GraphBucket[] }>(
        "GET",
        `planner/plans/${encodeURIComponent(plan.id)}/buckets`,
        tok.token,
      );
      if (bucketsRes.ok) {
        for (const b of bucketsRes.value.value ?? []) {
          await upsertBucket(planLocalId, b);
          bucketCount++;
        }
      }

      // Paginate tasks.
      let next: string | null =
        `planner/plans/${encodeURIComponent(plan.id)}/tasks?$top=100`;
      let pulled = 0;
      while (next && pulled < tasksPerPlan) {
        const tRes: GraphCall<{ value?: GraphTask[]; "@odata.nextLink"?: string }>
          | PlannerErrorResult = await graphCall(
          "GET",
          next,
          tok.token,
        );
        if (!tRes.ok) break;
        for (const t of tRes.value.value ?? []) {
          const bucketLocalId = t.bucketId ? (await resolveBucketIds(t.bucketId))?.localId ?? null : null;
          await upsertTask(userId, planLocalId, bucketLocalId, t);
          taskCount++;
          pulled++;
          if (pulled >= tasksPerPlan) break;
        }
        next = tRes.value["@odata.nextLink"] ?? null;
      }
    }
  }

  // Roster plans (plans not tied to a Group).
  const rosterRes = await graphCall<{ value?: GraphPlan[] }>(
    "GET",
    "me/planner/plans",
    tok.token,
  );
  if (rosterRes.ok) {
    for (const plan of rosterRes.value.value ?? []) {
      const type = (plan.container?.type ?? "").toLowerCase();
      if (type !== "roster") continue; // group plans already covered above
      const planLocalId = await upsertPlan(userId, plan, null, "roster");
      planCount++;
      const bucketsRes = await graphCall<{ value?: GraphBucket[] }>(
        "GET",
        `planner/plans/${encodeURIComponent(plan.id)}/buckets`,
        tok.token,
      );
      if (bucketsRes.ok) {
        for (const b of bucketsRes.value.value ?? []) {
          await upsertBucket(planLocalId, b);
          bucketCount++;
        }
      }
      const tRes = await graphCall<{ value?: GraphTask[] }>(
        "GET",
        `planner/plans/${encodeURIComponent(plan.id)}/tasks?$top=${tasksPerPlan}`,
        tok.token,
      );
      if (tRes.ok) {
        for (const t of tRes.value.value ?? []) {
          const bucketLocalId = t.bucketId ? (await resolveBucketIds(t.bucketId))?.localId ?? null : null;
          await upsertTask(userId, planLocalId, bucketLocalId, t);
          taskCount++;
        }
      }
    }
  }

  const durationMs = Date.now() - start;
  trackEvent("system.ms_planner_synced", userId, "system", {
    user_id: userId,
    plan_count: planCount,
    bucket_count: bucketCount,
    task_count: taskCount,
    duration_ms: durationMs,
  });

  return { ok: true, value: { planCount, bucketCount, taskCount, durationMs } };
}
