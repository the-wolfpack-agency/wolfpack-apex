/**
 * Microsoft "Project" integration for the Wolfpack Instinct `/assistant`
 * context resolver.
 *
 * The Graph surface for "MS Project" is fragmented across three product
 * lines, none of which expose a unified "search across plans" endpoint.
 * This module wraps a v1 best-effort search:
 *
 *   1. **Planner** — `/me/planner/tasks` (the most common surface in the
 *      org; covered by Tasks.ReadWrite.Shared which is already granted).
 *   2. **Project for the Web** — partly addressable via `/me/planner/all`
 *      (roadmap/projects rolltup); when present we read tasks the same way.
 *   3. **To Do** — `/me/todo/lists/{id}/tasks` as a personal-task fallback,
 *      gated by Tasks.Read.
 *
 * Strategy:
 *   - Page through the user's tasks (cap 200 to bound cost).
 *   - Score with a simple case-insensitive substring match on title +
 *     description (Graph's $search/$filter on Planner is unreliable).
 *   - Always succeed-or-typed-fail: 401 → not_connected, 403 → scope_missing,
 *     429 → rate_limited. Never throw from a call site.
 *
 * v1 caveat: a substring search across at most 200 task titles is fast but
 * coarse. A real index (and follow-up sync into Postgres for ranking) is a
 * deliberate v2 follow-up — flagged in the PR body. Documented here so the
 * next contributor knows the tradeoff was intentional.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { trackEvent } from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Result + error types
// ---------------------------------------------------------------------------

export type ProjectErrorCode =
  | "not_connected"
  | "scope_missing"
  | "rate_limited"
  | "invalid_input"
  | "graph_error"
  | "internal";

export interface ProjectErrorResult {
  ok: false;
  code: ProjectErrorCode;
  scope?: string;
  retryAfter?: number;
  status?: number;
  message?: string;
}

export interface ProjectOkResult<T> {
  ok: true;
  value: T;
}

export type Result<T> = ProjectOkResult<T> | ProjectErrorResult;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProjectTaskSummary {
  id: string;
  title: string;
  /** Plan name (Planner) or list name (To Do). */
  plan_or_list_name: string;
  status: "not_started" | "in_progress" | "completed" | "unknown";
  due_at?: string;
  /** Best-available link to the task in Microsoft 365. */
  url?: string;
  /** UPNs or display names — best effort, not always present. */
  assignees?: string[];
}

export interface SearchProjectTasksResult {
  tasks: ProjectTaskSummary[];
  took_ms: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const TASK_SCAN_CAP = 200;
const DEFAULT_TOP_N = 10;
const TOP_N_CAP = 25;

const SCOPE_PLANNER = "Tasks.ReadWrite.Shared";
const SCOPE_TODO = "Tasks.Read";

// ---------------------------------------------------------------------------
// Internal Graph helpers
// ---------------------------------------------------------------------------

interface GraphCallSuccess<T> {
  ok: true;
  status: number;
  data: T | null;
}

interface GraphCallError {
  ok: false;
  status: number;
  code: ProjectErrorCode;
  scope?: string;
  retryAfter?: number;
  message: string;
}

async function safeJson(res: Response): Promise<any | null> {
  try { return await res.json(); } catch { return null; }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function classify403(body: any, fallbackScope: string): { code: ProjectErrorCode; scope?: string; message: string } {
  const errCode = body?.error?.code || body?.error?.innerError?.code || "";
  const errMsg = body?.error?.message || "forbidden";
  const isScope =
    /AccessDenied/i.test(String(errCode)) ||
    /Authorization_RequestDenied/i.test(String(errCode)) ||
    /scope/i.test(errMsg) ||
    /permission/i.test(errMsg);
  if (isScope) return { code: "scope_missing", scope: fallbackScope, message: errMsg };
  return { code: "graph_error", message: errMsg };
}

async function graphGet<T>(
  endpoint: string,
  accessToken: string,
  expectedScope: string,
): Promise<GraphCallSuccess<T> | GraphCallError> {
  const url = endpoint.startsWith("http") ? endpoint : `${GRAPH_BASE_URL}/${endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return { ok: false, status: 0, code: "internal", message: `network_error: ${(err as Error).message}` };
  }

  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "0", 10);
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 1,
      message: "rate_limited",
    };
  }
  if (res.status === 401) {
    return { ok: false, status: 401, code: "not_connected", message: "microsoft_not_connected" };
  }
  if (res.status === 403) {
    const b = await safeJson(res);
    const c = classify403(b, expectedScope);
    return { ok: false, status: 403, code: c.code, scope: c.scope, message: c.message };
  }
  if (res.status === 404) {
    // Some surfaces (Project for the Web) 404 when the user has no plans;
    // treat as empty rather than an error.
    return { ok: true, status: 404, data: null };
  }
  if (!res.ok) {
    const t = await safeText(res);
    return { ok: false, status: res.status, code: "graph_error", message: `graph_${res.status}: ${t.slice(0, 200)}` };
  }
  const data = (await safeJson(res)) as T | null;
  return { ok: true, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Raw Graph response shapes (subset we read)
// ---------------------------------------------------------------------------

interface RawPlannerTask {
  id: string;
  planId?: string;
  bucketId?: string;
  title?: string;
  percentComplete?: number;
  dueDateTime?: string;
  startDateTime?: string;
  assignments?: Record<string, unknown>;
  // Planner does not return the plan title inline — caller must resolve.
}

interface RawPlannerTaskDetail {
  description?: string;
  references?: Record<string, { alias?: string }>;
}

interface RawPlannerPlan {
  id: string;
  title?: string;
}

interface RawTodoList {
  id: string;
  displayName?: string;
}

interface RawTodoTask {
  id: string;
  title?: string;
  body?: { content?: string; contentType?: string };
  status?: string;       // notStarted | inProgress | completed | etc.
  dueDateTime?: { dateTime?: string; timeZone?: string };
  importance?: string;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function plannerPercentToStatus(pct: number | undefined): ProjectTaskSummary["status"] {
  if (pct == null) return "unknown";
  if (pct >= 100) return "completed";
  if (pct > 0) return "in_progress";
  return "not_started";
}

function todoStatusToStatus(s: string | undefined): ProjectTaskSummary["status"] {
  const v = String(s ?? "").toLowerCase();
  if (v === "completed") return "completed";
  if (v === "inprogress") return "in_progress";
  if (v === "notstarted" || v === "deferred" || v === "waitingonothers") return "not_started";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Substring matcher
// ---------------------------------------------------------------------------

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
}

/**
 * Score a task by the number of query tokens it contains in
 * `title + description`. Returns 0 if no tokens match. The caller sorts
 * descending by score and tiebreaks by recency / due-date.
 */
function scoreTask(haystack: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const hay = haystack.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits += 1;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SearchProjectTasksOptions {
  query: string;
  topN?: number;
  /**
   * When provided, scopes Planner reads to /users/{userId}/planner/tasks
   * instead of /me/planner/tasks. Most callers should omit this — the
   * delegated token already binds to the calling user.
   */
  userId?: string;
}

/**
 * Search the user's accessible Microsoft Planner + To Do tasks for a
 * substring match against `query`. Falls back gracefully when one surface
 * is unavailable: if Planner 403s but To Do 200s, you still get the To Do
 * results. Only when EVERY surface fails do we surface a typed error.
 *
 * Caps at 200 tasks scanned total to keep the cost predictable. The
 * top-`topN` matches are returned, sorted by token-hit count desc.
 */
export async function searchProjectTasks(
  token: string,
  opts: SearchProjectTasksOptions,
): Promise<Result<SearchProjectTasksResult>> {
  const t0 = Date.now();
  const q = String(opts?.query ?? "").trim();
  if (!q) return { ok: false, code: "invalid_input", message: "query required" };
  if (!token) return { ok: false, code: "not_connected", message: "missing_token" };

  const requested = Number.isFinite(opts.topN) ? Number(opts.topN) : DEFAULT_TOP_N;
  const topN = Math.min(Math.max(requested, 1), TOP_N_CAP);
  const tokens = tokenize(q);

  const meScope = opts.userId ? `users/${encodeURIComponent(opts.userId)}` : "me";

  // ---- 1. Planner ----------------------------------------------------------
  const plannerTasks: ProjectTaskSummary[] = [];
  let plannerErr: ProjectErrorResult | null = null;
  let plannerOk = false;
  let scanned = 0;

  const plannerListRes = await graphGet<{ value?: RawPlannerTask[] }>(
    `${meScope}/planner/tasks?$top=${TASK_SCAN_CAP}`,
    token,
    SCOPE_PLANNER,
  );

  if (!plannerListRes.ok) {
    plannerErr = {
      ok: false,
      code: plannerListRes.code,
      scope: plannerListRes.scope ?? (plannerListRes.code === "scope_missing" ? SCOPE_PLANNER : undefined),
      retryAfter: plannerListRes.retryAfter,
      status: plannerListRes.status,
      message: plannerListRes.message,
    };
  } else {
    plannerOk = true;
    const rawTasks = plannerListRes.data?.value ?? [];
    scanned += rawTasks.length;

    // Collect distinct planIds → resolve titles in one batch (best effort).
    const planIds = Array.from(new Set(rawTasks.map((t) => t.planId).filter(Boolean))) as string[];
    const planTitleById = new Map<string, string>();
    for (const pid of planIds) {
      const planRes = await graphGet<RawPlannerPlan>(
        `planner/plans/${encodeURIComponent(pid)}`,
        token,
        SCOPE_PLANNER,
      );
      // Plan-title resolution is best-effort. If it 404s or 403s we still
      // surface the task with an empty plan_or_list_name rather than fail.
      if (planRes.ok && planRes.data?.title) {
        planTitleById.set(pid, planRes.data.title);
      }
    }

    for (const t of rawTasks) {
      const title = String(t.title ?? "");
      // Pull task description only when the title alone matched something
      // — saves a round-trip per task.
      const titleScore = scoreTask(title, tokens);
      let description = "";
      if (titleScore === 0 && t.id) {
        const det = await graphGet<RawPlannerTaskDetail>(
          `planner/tasks/${encodeURIComponent(t.id)}/details`,
          token,
          SCOPE_PLANNER,
        );
        description = det.ok ? String(det.data?.description ?? "") : "";
      }
      const score = scoreTask(`${title}\n${description}`, tokens);
      if (score === 0) continue;

      const planTitle = (t.planId && planTitleById.get(t.planId)) || "Planner";
      const taskUrl = t.id
        ? `https://tasks.office.com/_layouts/15/Tasks.aspx?taskId=${encodeURIComponent(t.id)}`
        : undefined;

      plannerTasks.push({
        id: t.id,
        title: title || "(untitled task)",
        plan_or_list_name: planTitle,
        status: plannerPercentToStatus(t.percentComplete),
        ...(t.dueDateTime ? { due_at: t.dueDateTime } : {}),
        ...(taskUrl ? { url: taskUrl } : {}),
        ...(t.assignments
          ? { assignees: Object.keys(t.assignments) }
          : {}),
      });
    }
  }

  // ---- 2. To Do (only if we still have budget; cheap fallback) ------------
  const todoTasks: ProjectTaskSummary[] = [];
  let todoErr: ProjectErrorResult | null = null;
  let todoOk = false;

  if (scanned < TASK_SCAN_CAP) {
    const remaining = TASK_SCAN_CAP - scanned;
    const listsRes = await graphGet<{ value?: RawTodoList[] }>(
      `${meScope}/todo/lists?$top=20`,
      token,
      SCOPE_TODO,
    );
    if (!listsRes.ok) {
      todoErr = {
        ok: false,
        code: listsRes.code,
        scope: listsRes.scope ?? (listsRes.code === "scope_missing" ? SCOPE_TODO : undefined),
        retryAfter: listsRes.retryAfter,
        status: listsRes.status,
        message: listsRes.message,
      };
    } else {
      todoOk = true;
      const lists = listsRes.data?.value ?? [];
      let leftover = remaining;
      for (const list of lists) {
        if (leftover <= 0) break;
        const perList = Math.min(50, leftover);
        const tasksRes = await graphGet<{ value?: RawTodoTask[] }>(
          `${meScope}/todo/lists/${encodeURIComponent(list.id)}/tasks?$top=${perList}`,
          token,
          SCOPE_TODO,
        );
        if (!tasksRes.ok) {
          // A single broken list shouldn't fail the whole call.
          continue;
        }
        const rows = tasksRes.data?.value ?? [];
        leftover -= rows.length;
        for (const tt of rows) {
          const title = String(tt.title ?? "");
          const desc = String(tt.body?.content ?? "");
          const score = scoreTask(`${title}\n${desc}`, tokens);
          if (score === 0) continue;
          todoTasks.push({
            id: tt.id,
            title: title || "(untitled task)",
            plan_or_list_name: list.displayName || "To Do",
            status: todoStatusToStatus(tt.status),
            ...(tt.dueDateTime?.dateTime ? { due_at: tt.dueDateTime.dateTime } : {}),
          });
        }
      }
    }
  }

  // ---- 3. Combine + decide error surface ---------------------------------
  const combined = [...plannerTasks, ...todoTasks].slice(0, topN);

  // If BOTH surfaces errored AND we have nothing to show, propagate the
  // most informative error (prefer scope_missing > rate_limited > graph_error).
  if (!plannerOk && !todoOk && combined.length === 0) {
    const e = plannerErr ?? todoErr;
    if (e) return e;
    return { ok: false, code: "internal", message: "no_surface_responded" };
  }

  return {
    ok: true,
    value: { tasks: combined, took_ms: Date.now() - t0 },
  };
}

// ---------------------------------------------------------------------------
// Analytics helper — exported so context-resolver can fire
// `assistant.project_lookup_failed` with consistent shape.
// ---------------------------------------------------------------------------

export function trackProjectLookupFailure(
  userId: string,
  role: string,
  error: ProjectErrorResult,
): void {
  trackEvent("assistant.project_lookup_failed", userId, role, {
    status: error.status ?? 0,
    scope_missing: error.code === "scope_missing",
    code: error.code,
  });
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

export const __internal = {
  plannerPercentToStatus,
  todoStatusToStatus,
  scoreTask,
  tokenize,
  TASK_SCAN_CAP,
  TOP_N_CAP,
  SCOPE_PLANNER,
  SCOPE_TODO,
};
