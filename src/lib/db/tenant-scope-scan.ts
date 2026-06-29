/**
 * tenant-scope-scan.ts — the DRY core of the repo-wide multi-tenant isolation
 * guardrail.
 *
 * WHY THIS EXISTS
 * Tenant isolation in this codebase is an explicit app-side `WHERE workspace_id`
 * predicate on every read/write that touches a workspace-scoped table (see
 * docs/tenant-isolation.md; Postgres RLS is only a permissive deny-by-default
 * tripwire today). A query that touches a workspace-scoped table WITHOUT that
 * predicate is a silent cross-tenant data leak — the single worst failure class
 * for a multi-tenant product.
 *
 * src/lib/platform-scan/__tests__/tenant-isolation.test.ts already guards the 7
 * platform-scan tables. This module generalises the SAME heuristics to EVERY
 * workspace-scoped table across ALL of src, so a forgotten predicate anywhere
 * fails the build. It is consumed by:
 *   - src/lib/db/__tests__/tenant-isolation-global.test.ts  (the PR gate)
 *   - scripts/scan-tenant-isolation.ts                      (CI + local report)
 *   - /api/cron/tenant-isolation-scan                        (records coverage
 *                                                             into the learning loop)
 *
 * HOW IT CLASSIFIES
 * A "filtering" statement (SELECT/UPDATE/DELETE) on a scoped table that lacks a
 * static `workspace_id = $n` predicate is an OFFENDER. Each offender is then
 * classified into a benign, named exception class — or "unclassified", which is
 * THE ALARM the guardrail trips on. The classes encode the only architecturally
 * sound reasons a tenant predicate can be absent:
 *
 *   principal-resolve       Identity tables (team_members / invites): a row IS a
 *                           principal, looked up by id/email BEFORE the caller's
 *                           workspace is known — the workspace is derived FROM
 *                           the row, not used to filter it.
 *   pk-pinned-upstream      The only identifying predicate is `id = $n`, a
 *                           globally-unique primary key that was resolved through
 *                           a workspace-scoped read upstream (e.g. an agent task
 *                           id from a scoped list, then `UPDATE ... WHERE id=$1`).
 *   resolves-from-credential A SELECT that RETURNS workspace_id, keyed on a
 *                           globally-unique credential (api key prefix, token):
 *                           it resolves which tenant a credential belongs to.
 *   system-cross-workspace  A system job (cron / health / drift / failover) that
 *                           deliberately enumerates rows across ALL workspaces
 *                           and SELECTs workspace_id to scope each downstream.
 *   dynamic-where           The WHERE predicate is built at runtime from a
 *                           `${...}` interpolation. The static scan can't see the
 *                           predicate, so the builder is verified by that store's
 *                           own unit tests (the where[] array seeds workspace_id).
 *   not-a-table-access      The table name only appears inside an
 *                           information_schema introspection / string list, not a
 *                           real row access.
 *
 * Anything else is "unclassified" — a query filtering a tenant-owned table by a
 * non-tenant business key (exactly the job-codes-dossier bug class). That fails
 * the guardrail and must be fixed by adding `AND workspace_id = $n`.
 *
 * Pure + fast: reads sources via fs only when called; no DB, no network.
 */
import fs from "fs";
import path from "path";

/** Identity tables: a row IS a principal; workspace is derived from it, not a
 *  filter on it. Lookups by id/email here are the "resolve the principal" class. */
export const PRINCIPAL_TABLES: ReadonlySet<string> = new Set([
  "instinct_team_members",
  "instinct_invites",
]);

export type OffenderClass =
  | "principal-resolve"
  | "pk-pinned-upstream"
  | "resolves-from-credential"
  | "system-cross-workspace"
  | "dynamic-where"
  | "not-a-table-access"
  | "unclassified";

export interface Offender {
  file: string;
  table: string;
  kind: "filter" | "insert";
  klass: OffenderClass;
  snippet: string;
}

export interface ScanResult {
  scopedTables: string[];
  /** Scoped tables that carry a real FORCE-RLS policy (session-var enforced),
   *  as opposed to the permissive deny-by-default tripwire. Tracks how far the
   *  RLS retrofit has progressed toward removing the whitepaper caveat. */
  enforcedTables: string[];
  filesScanned: number;
  filesTouchingScoped: number;
  offenders: Offender[];
  unclassified: Offender[];
  counts: Record<OffenderClass, number>;
}

// ---------------------------------------------------------------------------
// Discovery: which tables carry a workspace_id column (CREATE TABLE body or a
// later ALTER TABLE ... ADD COLUMN workspace_id).
// ---------------------------------------------------------------------------
export function discoverScopedTables(repoRoot: string): Set<string> {
  const dir = path.join(repoRoot, "src/db/migrations");
  const scoped = new Set<string>();
  for (const fn of fs.readdirSync(dir)) {
    if (!fn.endsWith(".sql") || fn.endsWith(".down.sql")) continue;
    const lines = fs.readFileSync(path.join(dir, fn), "utf8").split("\n");
    let current: string | null = null;
    for (const raw of lines) {
      const line = raw.replace(/--.*$/, "");
      const create = line.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/i);
      if (create) current = create[1];
      const alter = line.match(/ALTER TABLE\s+(\w+)/i);
      if (alter) current = alter[1];
      // A workspace_id column declaration (CREATE body) or ADD COLUMN.
      if (current && /\bworkspace_id\b\s+(text|uuid|varchar)/i.test(line)) {
        scoped.add(current);
      }
      if (current && /ADD COLUMN(?:\s+IF NOT EXISTS)?\s+workspace_id\b/i.test(line)) {
        scoped.add(current);
      }
    }
  }
  return scoped;
}

/**
 * Tables that have a REAL session-var RLS policy enforced (FORCE ROW LEVEL
 * SECURITY). Without FORCE, the table owner — the app's pooled connection role —
 * bypasses RLS entirely, so a policy alone is fake enforcement. The retrofit
 * graduates a table from tripwire (permissive USING(true)) to enforced by adding
 * FORCE; this counts how many have crossed that line.
 */
export function discoverForcedRlsTables(repoRoot: string): Set<string> {
  const dir = path.join(repoRoot, "src/db/migrations");
  const forced = new Set<string>();
  const dropped = new Set<string>();
  // Process in migration order so a later DISABLE/NO FORCE wins.
  for (const fn of fs.readdirSync(dir).sort()) {
    if (!fn.endsWith(".sql") || fn.endsWith(".down.sql")) continue;
    const text = fs.readFileSync(path.join(dir, fn), "utf8");
    for (const m of text.matchAll(/ALTER TABLE\s+(\w+)\s+FORCE ROW LEVEL SECURITY/gi)) {
      forced.add(m[1]);
      dropped.delete(m[1]);
    }
    for (const m of text.matchAll(/ALTER TABLE\s+(\w+)\s+NO FORCE ROW LEVEL SECURITY/gi)) {
      dropped.add(m[1]);
      forced.delete(m[1]);
    }
  }
  return forced;
}

// ---------------------------------------------------------------------------
// Source walk + SQL-literal extraction (mirrors the platform-scan guardrail).
// ---------------------------------------------------------------------------
export function listSourceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "migrations" || entry.name === "node_modules") continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  };
  walk(path.join(repoRoot, "src"));
  return out;
}

const SQL_VERB = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE)\b/i;

/** Backtick template literals that look like SQL. */
export function extractSqlLiterals(src: string): string[] {
  return (src.match(/`[^`]*`/gs) ?? []).filter((l) => SQL_VERB.test(l));
}

export function normalize(sql: string): string {
  return sql.replace(/`/g, "").replace(/\s+/g, " ").trim();
}
function snippet(sql: string): string {
  const s = normalize(sql);
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}

function isInsert(sql: string): boolean {
  return /\bINSERT\s+INTO\b/i.test(sql);
}
function isFiltering(sql: string): boolean {
  if (isInsert(sql)) return false;
  return /\b(SELECT|UPDATE|DELETE)\b/i.test(sql);
}
/** Static `workspace_id = $n` predicate present anywhere. */
function hasStaticWorkspacePredicate(sql: string): boolean {
  return /workspace_id\s*=\s*\$?\d/i.test(sql);
}
/** The text after the first WHERE (the predicate region). */
function whereRegion(sql: string): string {
  const parts = sql.split(/\bWHERE\b/i);
  return parts.length > 1 ? parts.slice(1).join(" WHERE ") : "";
}
/** WHERE predicate built from a `${...}` interpolation — static scan can't see it. */
function hasInterpolatedWhere(sql: string): boolean {
  return /\$\{/.test(whereRegion(sql));
}
/** The SELECT column list (before the first FROM). */
function selectList(sql: string): string {
  const i = sql.search(/\bFROM\b/i);
  return i < 0 ? "" : sql.slice(0, i);
}
function selectsWorkspaceId(sql: string): boolean {
  return /\bworkspace_id\b/.test(selectList(sql));
}
/** WHERE pins by the primary key `id = $n` (note: \bid\b never matches user_id). */
function pinsByPrimaryKey(sql: string): boolean {
  return /\bid\s*=\s*\$\d/i.test(whereRegion(sql));
}
function filtersByCredential(sql: string): boolean {
  return /\b(key_prefix|key_hash|token|onboarding_secret_hash|api_key|secret_hash)\b/i.test(
    whereRegion(sql),
  );
}
function isInformationSchema(sql: string): boolean {
  return /information_schema/i.test(sql);
}

export function tablesIn(sql: string, scoped: Set<string>): string[] {
  return [...scoped].filter((t) => new RegExp(`\\b${t}\\b`).test(sql)).sort();
}

/** Classify a filtering offender (already known to lack a static workspace
 *  predicate) on a scoped table into a benign class or "unclassified". */
export function classifyFilter(file: string, sql: string, table: string): OffenderClass {
  if (isInformationSchema(sql)) return "not-a-table-access";
  if (hasInterpolatedWhere(sql)) return "dynamic-where";
  if (PRINCIPAL_TABLES.has(table)) return "principal-resolve";
  if (selectsWorkspaceId(sql)) {
    return filtersByCredential(sql) ? "resolves-from-credential" : "system-cross-workspace";
  }
  if (pinsByPrimaryKey(sql)) return "pk-pinned-upstream";
  return "unclassified";
}

function classifyInsert(table: string): OffenderClass {
  // An INSERT into a workspace-scoped table must supply workspace_id as a column.
  // The only benign omission is a principal/identity row (e.g. provisioning a
  // system bot account on the identity table).
  return PRINCIPAL_TABLES.has(table) ? "principal-resolve" : "unclassified";
}

const EMPTY_COUNTS = (): Record<OffenderClass, number> => ({
  "principal-resolve": 0,
  "pk-pinned-upstream": 0,
  "resolves-from-credential": 0,
  "system-cross-workspace": 0,
  "dynamic-where": 0,
  "not-a-table-access": 0,
  unclassified: 0,
});

/** Scan the whole repo for tenant-scope offenders. */
export function scanRepo(repoRoot: string): ScanResult {
  const scoped = discoverScopedTables(repoRoot);
  const forced = discoverForcedRlsTables(repoRoot);
  const files = listSourceFiles(repoRoot);
  const offenders: Offender[] = [];
  const touching = new Set<string>();

  for (const abs of files) {
    const rel = path.relative(repoRoot, abs);
    const src = fs.readFileSync(abs, "utf8");
    for (const lit of extractSqlLiterals(src)) {
      const tabs = tablesIn(lit, scoped);
      if (tabs.length === 0) continue;
      touching.add(rel);
      for (const table of tabs) {
        if (isInsert(lit)) {
          if (!/workspace_id/i.test(lit)) {
            offenders.push({ file: rel, table, kind: "insert", klass: classifyInsert(table), snippet: snippet(lit) });
          }
        } else if (isFiltering(lit) && !hasStaticWorkspacePredicate(lit)) {
          offenders.push({ file: rel, table, kind: "filter", klass: classifyFilter(rel, lit, table), snippet: snippet(lit) });
        }
      }
    }
  }

  const counts = EMPTY_COUNTS();
  for (const o of offenders) counts[o.klass] += 1;
  return {
    scopedTables: [...scoped].sort(),
    // Only count FORCE-RLS on tables that are actually workspace-scoped.
    enforcedTables: [...forced].filter((t) => scoped.has(t)).sort(),
    filesScanned: files.length,
    filesTouchingScoped: touching.size,
    offenders,
    unclassified: offenders.filter((o) => o.klass === "unclassified"),
    counts,
  };
}
