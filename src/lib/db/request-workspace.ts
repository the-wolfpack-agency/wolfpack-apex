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

const store = new AsyncLocalStorage<{ workspaceId: string }>();
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

/** The workspace bound for this request, if any. */
export function boundRequestWorkspace(): string | undefined {
  const explicit = store.getStore()?.workspaceId;
  if (explicit) return explicit;
  const key = currentRequestKey();
  return key ? byRequest.get(key) : undefined;
}

/** Run fn with a workspace bound (tests, and callers that already own a context). */
export function runWithRequestWorkspace<R>(workspaceId: string, fn: () => R): R {
  return store.run({ workspaceId }, fn);
}
