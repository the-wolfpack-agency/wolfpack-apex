/**
 * tenant-isolation.test.ts
 *
 * GUARDRAIL: the REAL, enforced multi-tenant isolation for the platform-scan /
 * onboarding stores is an explicit app-side `workspace_id` predicate on every
 * read/write that touches a workspace-scoped table. (This codebase deliberately
 * does NOT use session-var RLS - see docs/tenant-isolation.md and migration
 * 196_platform_scan_rls.sql, where RLS is enabled only as a permissive
 * deny-by-default tripwire. The predicate below is the thing that actually keeps
 * workspace A from reading or mutating workspace B's findings, profiles,
 * recommendations, pentest scopes, onboarded targets, or ownership-verification
 * state.)
 *
 * A query that touches one of those tables WITHOUT a workspace_id predicate is a
 * silent cross-tenant data leak: the query runs, just over the wrong rows. This
 * is the single worst failure class for a multi-tenant product, so it gets a
 * source-assertion guardrail in the style of
 * src/lib/search/__tests__/provider-coverage.test.ts and the existing
 * workspace-scoping.test.ts: walk every store source file, extract the SQL
 * string literals, and assert each one that references a workspace-scoped table
 * is scoped - failing loudly (naming the file + the offending SQL) if a future
 * query forgets the filter.
 *
 * The one principled exception is captured in QUERY_ALLOWLIST below with a
 * one-phrase reason: a query may pin a row by its PRIMARY KEY (`id = $N`)
 * WITHOUT a workspace_id predicate ONLY when that id was already resolved through
 * a workspace-scoped query upstream. The canonical case is consumeBudget() in
 * pentest/scope.ts, whose scopeId comes from getActiveScope() (itself
 * `WHERE workspace_id = $1 AND platform = $2`). The allowlist is explicit so the
 * exception can never be silently widened.
 *
 * No DB: reads sources via fs so the test stays fast.
 */
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/**
 * Every platform-scan / onboarding source file that runs SQL against a
 * workspace-scoped table. Enumerated by grepping the table names across
 * src/lib/platform-scan (excluding tests). If a new store module is added, it
 * MUST be appended here (the existence check below fails on a typo'd path).
 */
const STORE_FILES = [
  "src/lib/platform-scan/store.ts",
  "src/lib/platform-scan/targets-store.ts",
  "src/lib/platform-scan/profile/store.ts",
  "src/lib/platform-scan/recommend/store.ts",
  "src/lib/platform-scan/pentest/scope.ts",
  "src/lib/platform-scan/authorization/index.ts",
] as const;

/**
 * Tables whose every row belongs to exactly one tenant (keyed on workspace_id).
 * MUST stay in lockstep with the table list enabled by migration 196 - the
 * "migration covers exactly this set" test below enforces that.
 */
const WORKSPACE_SCOPED_TABLES = [
  "instinct_platform_scans",
  "instinct_platform_scan_findings",
  "instinct_system_profiles",
  "instinct_automation_recommendations",
  "instinct_pentest_authorizations",
  "instinct_scan_targets",
  "instinct_target_verifications",
] as const;

/**
 * Principled exceptions: a SQL snippet that references a workspace-scoped table
 * but is allowed to omit the workspace_id predicate, each with a one-phrase
 * reason. The matcher is a substring of the normalized (whitespace-collapsed)
 * SQL, so it pins the specific query, not a whole file. Keep this list as small
 * as the architecture demands - every entry is a place isolation depends on an
 * upstream guarantee rather than the predicate itself.
 */
export const QUERY_ALLOWLIST: { file: string; sqlIncludes: string; reason: string }[] = [
  {
    file: "src/lib/platform-scan/pentest/scope.ts",
    sqlIncludes: "UPDATE instinct_pentest_authorizations",
    // consumeBudget(scopeId): pk-pinned `WHERE id = $1`; scopeId was resolved
    // upstream by getActiveScope which is `WHERE workspace_id = $1 AND platform`.
    reason: "consumeBudget pins by pk id resolved through a workspace-scoped getActiveScope upstream",
  },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** Pull every backtick-delimited string literal (the stores pass SQL as
 *  backtick template literals to safeQuery / writeQuery). */
function backtickLiterals(src: string): string[] {
  return src.match(/`[^`]*`/gs) ?? [];
}

/** Collapse a SQL literal to a one-line, backtick-free snippet for matching +
 *  reporting. */
function normalize(sql: string): string {
  return sql.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function snippet(sql: string): string {
  const oneLine = normalize(sql);
  return oneLine.length > 180 ? `${oneLine.slice(0, 180)}...` : oneLine;
}

/** Which workspace-scoped tables a SQL literal references. */
function scopedTablesIn(sql: string): string[] {
  return WORKSPACE_SCOPED_TABLES.filter((t) => sql.includes(t));
}

/** An `INSERT INTO ... ON CONFLICT DO UPDATE` upsert is an INSERT, not a
 *  filtering statement: its conflict target is the (workspace_id, ...) identity
 *  index and it supplies workspace_id as a column, so it is covered by the
 *  INSERT column-value check below, not the WHERE-predicate check. */
function isInsert(sql: string): boolean {
  return /\bINSERT\s+INTO\b/i.test(sql);
}

/** Is this a read/write that must carry a tenant predicate?
 *  Standalone SELECT / UPDATE / DELETE all filter rows, so all three require a
 *  workspace_id predicate. INSERT (including upserts) does not filter rows - it
 *  supplies workspace_id as a column value, checked separately. */
function isFilteringStatement(sql: string): boolean {
  if (isInsert(sql)) return false;
  return /\b(SELECT|UPDATE|DELETE)\b/i.test(sql);
}

/** A filtering query is tenant-scoped if it constrains workspace_id in a
 *  predicate (`workspace_id = ...` after WHERE/AND). The bare presence of the
 *  word isn't enough - it must appear in a comparison, not just a column list. */
function hasWorkspacePredicate(sql: string): boolean {
  return /workspace_id\s*=\s*\$?\d?/i.test(sql);
}

/** Is this query covered by an explicit allowlist entry for its file? */
function isAllowlisted(rel: string, sql: string): boolean {
  const norm = normalize(sql);
  return QUERY_ALLOWLIST.some((e) => e.file === rel && norm.includes(e.sqlIncludes));
}

describe("platform-scan tenant isolation guardrail", () => {
  it("references every store file under the repo root", () => {
    for (const rel of STORE_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
  });

  describe.each(STORE_FILES)("%s", (rel) => {
    const src = read(rel);
    const literals = backtickLiterals(src);
    const scopedQueries = literals.filter((sql) => scopedTablesIn(sql).length > 0);

    it("every SELECT/UPDATE/DELETE against a workspace-scoped table has a workspace_id predicate (or is allowlisted)", () => {
      const offenders = scopedQueries
        .filter(isFilteringStatement)
        .filter((sql) => !hasWorkspacePredicate(sql))
        .filter((sql) => !isAllowlisted(rel, sql))
        .map(
          (sql) =>
            `CROSS-TENANT LEAK: ${rel} runs a SELECT/UPDATE/DELETE on ${scopedTablesIn(sql).join(
              ", ",
            )} with NO workspace_id predicate and NO allowlist entry:\n  ${snippet(sql)}`,
        );
      // Clean run = empty. On failure jest prints each leaking query verbatim.
      // If this trips, FIX THE QUERY (add `AND workspace_id = $N`); do not relax
      // the rule. Only add to QUERY_ALLOWLIST for a genuine pk-pinned-upstream
      // case, with a one-phrase reason.
      expect(offenders).toEqual([]);
    });

    it("every INSERT into a workspace-scoped table supplies workspace_id as a column", () => {
      const inserts = scopedQueries.filter((sql) => /\bINSERT\s+INTO\b/i.test(sql));
      const offenders = inserts
        .filter((sql) => !/workspace_id/i.test(sql))
        .map(
          (sql) =>
            `UNSCOPED INSERT: ${rel} inserts into ${scopedTablesIn(sql).join(
              ", ",
            )} without a workspace_id column:\n  ${snippet(sql)}`,
        );
      expect(offenders).toEqual([]);
    });

    it("is tenant-aware (references workspace_id at least once)", () => {
      expect(src).toContain("workspace_id");
    });
  });

  // The allowlist must stay honest: every entry points at a real file and a SQL
  // snippet that actually exists there. A stale entry would silently widen the
  // exception surface.
  describe("QUERY_ALLOWLIST integrity", () => {
    it.each(QUERY_ALLOWLIST)("%o targets an existing file + SQL", (entry) => {
      expect(STORE_FILES).toContain(entry.file as (typeof STORE_FILES)[number]);
      const literals = backtickLiterals(read(entry.file)).map(normalize);
      expect(literals.some((sql) => sql.includes(entry.sqlIncludes))).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(0);
    });

    it("the allowlisted query genuinely pins by a pk id predicate (the exception is load-bearing)", () => {
      // The only permitted exception class is "row pinned by pk id, resolved
      // upstream through a workspace-scoped query". Assert the consumeBudget
      // UPDATE really is `WHERE id = $1` and carries no workspace_id, so the
      // exception can't quietly become a workspace-blind WHERE that just happens
      // to mention "id".
      const literals = backtickLiterals(read("src/lib/platform-scan/pentest/scope.ts"));
      const idPinned = literals.filter(
        (sql) =>
          sql.includes("instinct_pentest_authorizations") &&
          /\bUPDATE\b/i.test(sql) &&
          /\bid\s*=\s*\$1\b/.test(sql) &&
          !hasWorkspacePredicate(sql),
      );
      expect(idPinned.length).toBeGreaterThanOrEqual(1);
    });
  });

  // Migration well-formedness: 196 must enable RLS + a permissive policy on
  // EXACTLY the workspace-scoped table set above. This couples the SQL tripwire
  // to the source guardrail so they can't drift (a new scoped table added to one
  // list but not the other fails here).
  describe("migration 196 RLS tripwire is well-formed", () => {
    const MIGRATION = "src/db/migrations/196_platform_scan_rls.sql";
    const DOWN = "src/db/migrations/196_platform_scan_rls.down.sql";
    const up = read(MIGRATION);
    const down = read(DOWN);

    it.each(WORKSPACE_SCOPED_TABLES)("enables RLS + permissive policy on %s", (table) => {
      expect(up).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(up).toContain(`DROP POLICY IF EXISTS ${table}_all ON ${table}`);
      expect(up).toContain(
        `CREATE POLICY ${table}_all ON ${table}\n  FOR ALL USING (true) WITH CHECK (true)`,
      );
    });

    it("covers exactly the workspace-scoped table set (no extra, no missing)", () => {
      const enabled = [...up.matchAll(/ALTER TABLE (\w+) ENABLE ROW LEVEL SECURITY/g)].map(
        (m) => m[1],
      );
      expect(new Set(enabled)).toEqual(new Set(WORKSPACE_SCOPED_TABLES));
    });

    it("adds no columns and writes no data (tripwire only)", () => {
      expect(up).not.toMatch(/ADD COLUMN/i);
      expect(up).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(up).not.toMatch(/\bUPDATE\s+instinct_/i);
      expect(up).not.toMatch(/\bDELETE\s+FROM\b/i);
    });

    it("does NOT attempt session-var RLS (no current_setting / set_config plumbing)", () => {
      // Deliberate: this repo has no app.workspace_id session var; a
      // current_setting policy would deny every query. See docs/tenant-isolation.md.
      // Strip `-- ...` comments first so the explanatory header (which names these
      // functions precisely to say we DON'T use them) doesn't trip the check -
      // we're asserting about executable SQL, not prose.
      const executable = up.replace(/--[^\n]*/g, "");
      expect(executable).not.toMatch(/current_setting/i);
      expect(executable).not.toMatch(/set_config/i);
    });

    it("is idempotent (DROP POLICY IF EXISTS before CREATE, mirrors migration 083)", () => {
      const drops = (up.match(/DROP POLICY IF EXISTS/g) ?? []).length;
      const creates = (up.match(/CREATE POLICY/g) ?? []).length;
      expect(drops).toBe(WORKSPACE_SCOPED_TABLES.length);
      expect(creates).toBe(WORKSPACE_SCOPED_TABLES.length);
    });

    it("has a paired down migration that disables RLS on every table", () => {
      for (const table of WORKSPACE_SCOPED_TABLES) {
        expect(down).toContain(`DROP POLICY IF EXISTS ${table}_all ON ${table}`);
        expect(down).toContain(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      }
    });
  });
});
