/**
 * request-workspace.ts - the per-request workspace binding behind the RLS
 * cutover flag (INSTINCT_RLS_SESSION_CONTEXT). Kept apart from db.ts so the
 * auth layer can bind without importing the pool, and so the hundreds of test
 * files that mock "@/lib/db" do not have to know about it.
 *
 * requireCapability calls bindRequestWorkspace(user.workspaceId) after the
 * caller is authenticated. query() in db.ts reads boundRequestWorkspace() and,
 * when the flag is on, sets app.workspace_id for each statement. Flag off (the
 * default): bindRequestWorkspace is a no-op and nothing is ever bound.
 *
 * WHERE THE BINDING LIVES. requireCapability is an awaited helper, and an
 * AsyncLocalStorage.enterWith made inside it does not reliably reach the
 * route handler that awaited it (it did not under Jest's runtime; see
 * db-rls-session-context.test.ts). So the binding is keyed on the per-request
 * work-unit store Next.js itself runs every route handler inside: one object
 * per request, never shared, garbage-collected with the request (WeakMap).
 * getStore() has no side effects (unlike headers(), which would mark a cached
 * scope dynamic). Outside a Next request (scripts, tests) nothing is bound
 * unless the caller uses runWithRequestWorkspace explicitly. The cutover
 * runbook verifies the binding on the deployed runtime before production
 * (docs/security/rls-cutover.md, step 4).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";

/** The RLS context a statement runs under. `pinned` marks withWorkspaceScope
 *  (db.ts), which owns a transaction and must not be re-scoped from inside. */
export type RlsContext =
  | { kind: "workspace"; workspaceId: string; pinned?: boolean }
  | { kind: "system" };

const store = new AsyncLocalStorage<RlsContext>();
const byRequest = new WeakMap<object, string>();

/** The current Next.js request's work-unit store, or undefined outside one. */
function currentRequestKey(): object | undefined {
  try {
    return (workUnitAsyncStorage.getStore() as object | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Default OFF. Only on/true/1 enables it. */
export function rlsSessionContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.INSTINCT_RLS_SESSION_CONTEXT ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

/** Bind the verified workspace for the rest of this request. No-op while the flag is off. */
export function bindRequestWorkspace(workspaceId: string | null | undefined): void {
  if (!workspaceId || !rlsSessionContextEnabled()) return;
  const key = currentRequestKey();
  if (key) byRequest.set(key, workspaceId);
}

/** The innermost explicit context, else the workspace bound to this request. */
export function boundRlsContext(): RlsContext | undefined {
  const explicit = store.getStore();
  if (explicit) return explicit;
  const key = currentRequestKey();
  const ws = key ? byRequest.get(key) : undefined;
  return ws ? { kind: "workspace", workspaceId: ws } : undefined;
}

/** The workspace bound for this request, if any (undefined under system scope). */
export function boundRequestWorkspace(): string | undefined {
  const ctx = boundRlsContext();
  return ctx?.kind === "workspace" ? ctx.workspaceId : undefined;
}

/**
 * Run fn with a workspace bound: per-workspace job work (a sweep's loop body),
 * tests, and callers that already own a verified workspace id. An empty id binds
 * nothing and runs fn as it is. Refuses to re-scope a pinned withWorkspaceScope.
 */
export function runWithRequestWorkspace<R>(workspaceId: string, fn: () => R): R {
  if (!workspaceId) return fn();
  const cur = store.getStore();
  if (cur?.kind === "workspace" && cur.pinned && cur.workspaceId !== workspaceId) {
    throw new Error(`runWithRequestWorkspace nesting mismatch: already scoped to '${cur.workspaceId}', refused re-scope to '${workspaceId}'`);
  }
  return store.run({ kind: "workspace", workspaceId }, fn);
}

/**
 * Run fn as SYSTEM work that legitimately spans workspaces (a cron's work list,
 * a queue claim, a deliberate cross-workspace aggregate). Under the flag every
 * query() and withTransaction() inside runs with app.rls_system = 'on', which
 * the workspace policies admit. Each statement still runs in its own short
 * transaction, exactly like a request-bound one, so a long sweep never holds a
 * connection or a transaction open and one failed statement cannot poison the
 * rest. Flag off: a marker nothing reads.
 *
 * Code decides when this is used, never request input. Wrap the enumerating
 * statement, not the whole job: per-workspace work belongs in
 * runWithRequestWorkspace.
 */
export function withSystemScope<R>(fn: () => Promise<R>): Promise<R> {
  const cur = store.getStore();
  if (cur?.kind === "workspace" && cur.pinned) {
    return Promise.reject(new Error(`withSystemScope nesting mismatch: already scoped to '${cur.workspaceId}'`));
  }
  return store.run({ kind: "system" }, fn);
}

/** True inside withSystemScope (and not narrowed back to a workspace). */
export function inSystemScope(): boolean {
  return store.getStore()?.kind === "system";
}

/** db.ts withWorkspaceScope only: mark the pinned scope so nothing re-scopes it. */
export function runPinnedWorkspace<R>(workspaceId: string, fn: () => R): R {
  const cur = store.getStore();
  if (cur?.kind === "system") {
    throw new Error(`withWorkspaceScope nesting mismatch: already scoped to system, refused re-scope to '${workspaceId}'`);
  }
  return store.run({ kind: "workspace", workspaceId, pinned: true }, fn);
}
