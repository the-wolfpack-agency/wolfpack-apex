/**
 * rls-context-scan.ts - static checks behind the RLS cutover's cron guard
 * (src/lib/db/__tests__/rls-cron-context.test.ts).
 *
 * Once the app connects as a role without BYPASSRLS and
 * INSTINCT_RLS_SESSION_CONTEXT is on, a statement on an RLS-covered table
 * (migrations 296/297) returns zero rows unless it runs under a workspace
 * context or withSystemScope(). A request gets its context from
 * requireCapability. A cron or sweep has no caller, so it must set one itself,
 * and a cron that forgets does not fail: it quietly does nothing. This module
 * finds, for every scheduled route, which covered tables it can reach through
 * its static import graph, so the guard can insist each one declares a context.
 *
 * Pure: reads source and migration files only. No DB, no network.
 */
import fs from "fs";
import path from "path";

/** Migrations that carry the workspace policies. */
export const RLS_POLICY_MIGRATIONS = [
  "296_rls_workspace_policies.sql",
  "297_rls_workspace_policies_remaining.sql",
] as const;

/** Tables whose rows the workspace policies filter, read from the migrations. */
export function rlsCoveredTables(repoRoot: string): Set<string> {
  const out = new Set<string>();
  for (const f of RLS_POLICY_MIGRATIONS) {
    const sql = fs.readFileSync(path.join(repoRoot, "src/db/migrations", f), "utf8");
    for (const m of sql.matchAll(/^CREATE POLICY (\w+)_ws_isolation ON (\w+)/gm)) out.add(m[2]);
  }
  return out;
}

/**
 * Every scheduled route: each directory under src/app/api/cron, plus every
 * cron path in vercel.json that lives elsewhere. Repo-relative route.ts paths.
 */
export function scheduledRoutes(repoRoot: string): string[] {
  const out = new Set<string>();
  const cronDir = path.join(repoRoot, "src/app/api/cron");
  for (const d of fs.readdirSync(cronDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const rel = path.join("src/app/api/cron", d.name, "route.ts");
    if (fs.existsSync(path.join(repoRoot, rel))) out.add(rel);
  }
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8")) as {
    crons?: Array<{ path: string }>;
  };
  for (const c of config.crons ?? []) {
    const p = c.path.split("?")[0].replace(/^\/+/, "");
    out.add(path.join("src/app", p, "route.ts"));
  }
  return [...out].sort();
}

function resolveImport(repoRoot: string, fromAbs: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(repoRoot, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromAbs), spec);
  else return undefined;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return undefined;
}

/** Runtime imports of a source file: static, re-exports, side-effect,
 *  dynamic import() and require(). Type-only imports are skipped. */
export function runtimeImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']/gm)) {
    if (!m[1]) out.push(m[2]);
  }
  for (const m of src.matchAll(/^\s*import\s+(type\s+)?\{[^}]*\}\s*from\s+["']([^"']+)["']/gms)) {
    if (!m[1]) out.push(m[2]);
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of src.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return [...new Set(out)];
}

/**
 * Files reachable from `entryRel` through runtime imports under src/. Files in
 * `stopAt` are not entered: requireCapability, whose callers are a signed-in
 * person with their workspace already bound.
 */
export function reachableFiles(repoRoot: string, entryRel: string, stopAt: ReadonlySet<string>): Set<string> {
  const start = path.join(repoRoot, entryRel);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const f = queue.pop() as string;
    for (const spec of runtimeImports(fs.readFileSync(f, "utf8"))) {
      const r = resolveImport(repoRoot, f, spec);
      if (!r || seen.has(r) || r.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if (stopAt.has(path.relative(repoRoot, r))) continue;
      seen.add(r);
      queue.push(r);
    }
  }
  return new Set([...seen].map((a) => path.relative(repoRoot, a)));
}

const SQL_VERB = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE)\b/i;

/** Covered tables named by any SQL template literal in the source. */
export function coveredTablesIn(src: string, covered: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const lit of src.match(/`[^`]*`/gs) ?? []) {
    if (!SQL_VERB.test(lit)) continue;
    for (const t of covered) if (new RegExp(`\\b${t}\\b`).test(lit)) found.add(t);
  }
  return [...found].sort();
}

export type ContextKind = "system" | "workspace";

/** Does the source itself establish this kind of RLS context? */
export function setsContext(src: string, kind: ContextKind): boolean {
  return kind === "system"
    ? /\bwithSystemScope\(/.test(src)
    : /\b(runWithRequestWorkspace|withWorkspaceScope)\(/.test(src);
}

export interface CronReach {
  route: string;
  /** Reachable files that name a covered table, with those tables. */
  touching: Record<string, string[]>;
  reachable: Set<string>;
}

/** For one scheduled route: which covered tables it can reach, and where. */
export function cronReach(
  repoRoot: string,
  routeRel: string,
  covered: ReadonlySet<string>,
  stopAt: ReadonlySet<string>,
): CronReach {
  const reachable = reachableFiles(repoRoot, routeRel, stopAt);
  const touching: Record<string, string[]> = {};
  for (const f of reachable) {
    const tables = coveredTablesIn(fs.readFileSync(path.join(repoRoot, f), "utf8"), covered);
    if (tables.length) touching[f] = tables;
  }
  return { route: routeRel, touching, reachable };
}
