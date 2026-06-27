/**
 * GUARDRAIL: multi-tenant workspace scoping for the platform-scan stores.
 *
 * Every workspace-scoped table is keyed on `workspace_id` (the tenant key). A
 * query that touches one of those tables WITHOUT scoping it is a cross-tenant
 * data leak: workspace A reads or mutates workspace B's findings, profiles,
 * recommendations, pentest scopes, or onboarded targets. That is the single
 * worst failure class for a multi-tenant product, and it fails silently (the
 * query runs, just over the wrong rows).
 *
 * This is a SOURCE-ASSERTION test (no DB), in the style of
 * src/__tests__/no-raw-api-fetch.test.ts: it reads each store file as text,
 * extracts the backtick-delimited SQL string literals, and for every literal
 * that references a workspace-scoped table asserts the query is scoped by
 * EITHER:
 *   1. `workspace_id` (the tenant key, the normal case), OR
 *   2. a primary-key id predicate `id = $N` — allowed because such an id was
 *      already resolved through a workspace-scoped query upstream (the canonical
 *      example is consumeBudget(scopeId) in pentest/scope.ts, which UPDATEs
 *      `WHERE id = $1`: the scopeId came from getActiveScope, which is itself
 *      `WHERE workspace_id = $1 AND platform = $2`).
 *
 * A query with NEITHER fails the test, naming the file and an SQL snippet. The
 * intent is to surface a real leak, never to be silenced: if this trips, do NOT
 * relax the rule in source to make it pass; fix the offending query.
 */
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** Store files that own writes/reads against workspace-scoped tables. */
const STORE_FILES = [
  "src/lib/platform-scan/store.ts",
  "src/lib/platform-scan/profile/store.ts",
  "src/lib/platform-scan/recommend/store.ts",
  "src/lib/platform-scan/pentest/scope.ts",
  "src/lib/platform-scan/targets-store.ts",
] as const;

/** Tables whose every row belongs to exactly one tenant (workspace). */
const WORKSPACE_SCOPED_TABLES = [
  "instinct_platform_scans",
  "instinct_platform_scan_findings",
  "instinct_system_profiles",
  "instinct_automation_recommendations",
  "instinct_pentest_authorizations",
  "instinct_scan_targets",
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** Pull every backtick-delimited string literal out of a source file. The
 *  stores pass their SQL as backtick template literals to safeQuery/writeQuery,
 *  so this captures exactly the query strings (and harmlessly any other
 *  backtick literal, which simply won't reference a scoped table). */
function backtickLiterals(src: string): string[] {
  return src.match(/`[^`]*`/gs) ?? [];
}

/** A SQL literal is "scoped" if it mentions the tenant key OR pins a row by its
 *  primary key (an id resolved upstream through a workspace-scoped query). */
function isScoped(sql: string): boolean {
  if (sql.includes("workspace_id")) return true;
  if (/\bid = \$\d/.test(sql)) return true;
  return false;
}

/** Which workspace-scoped tables a given SQL literal references. */
function scopedTablesIn(sql: string): string[] {
  return WORKSPACE_SCOPED_TABLES.filter((t) => sql.includes(t));
}

function snippet(sql: string): string {
  const oneLine = sql.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}

describe("platform-scan workspace scoping guardrail", () => {
  it("references every store file under the repo root", () => {
    for (const rel of STORE_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
  });

  describe.each(STORE_FILES)("%s", (rel) => {
    const src = read(rel);
    const literals = backtickLiterals(src);
    const scopedQueries = literals.filter((sql) => scopedTablesIn(sql).length > 0);

    it("scopes EVERY query against a workspace-scoped table by workspace_id or a pk id predicate", () => {
      const offenders = scopedQueries
        .filter((sql) => !isScoped(sql))
        .map(
          (sql) =>
            `CROSS-TENANT LEAK: ${rel} has a query touching ${scopedTablesIn(sql).join(
              ", ",
            )} with NEITHER workspace_id NOR a pk id predicate:\n  ${snippet(sql)}`,
        );
      // A clean run = empty offenders. On failure jest prints each leaking query.
      expect(offenders).toEqual([]);
    });

    it("references workspace_id at least once (sanity: the file is tenant-aware)", () => {
      expect(src).toContain("workspace_id");
    });
  });

  // Focused positive assertions: the two read paths that back the review UI must
  // bind the tenant on the first parameter. If a refactor drops the predicate,
  // this fails loudly with the specific query named, not just the broad sweep.
  describe("store.ts read paths bind the tenant on $1", () => {
    const src = read("src/lib/platform-scan/store.ts");
    const literals = backtickLiterals(src);

    it("listFindings + summarizeFindings select with `workspace_id = $1`", () => {
      const findingSelects = literals.filter(
        (sql) =>
          sql.includes("FROM instinct_platform_scan_findings") && sql.includes("SELECT"),
      );
      // Both SELECT-from-findings literals (listFindings, summarizeFindings).
      expect(findingSelects.length).toBeGreaterThanOrEqual(2);
      for (const sql of findingSelects) {
        expect(sql).toContain("workspace_id = $1");
      }
    });
  });

  // The id-predicate exception is load-bearing: assert the one query that relies
  // on it (consumeBudget) is genuinely a pk lookup, so the exception can't be
  // quietly widened into a workspace-blind WHERE that happens to mention "id".
  describe("pentest/scope.ts consumeBudget uses the pk id exception", () => {
    const src = read("src/lib/platform-scan/pentest/scope.ts");
    const literals = backtickLiterals(src);

    it("has an UPDATE on instinct_pentest_authorizations scoped by `id = $1`", () => {
      const idScoped = literals.filter(
        (sql) =>
          sql.includes("instinct_pentest_authorizations") &&
          /\bid = \$1\b/.test(sql) &&
          !sql.includes("workspace_id"),
      );
      // consumeBudget is exactly this shape: pk-pinned, no workspace_id, and the
      // scopeId was resolved upstream through getActiveScope (workspace-scoped).
      expect(idScoped.length).toBeGreaterThanOrEqual(1);
    });
  });
});
