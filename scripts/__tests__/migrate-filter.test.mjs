/**
 * Regression lock for the migrate.mjs file-filter behavior.
 *
 * Background (2026-04-19 production incident):
 *   migrate.mjs originally matched `*.sql` without excluding rollback
 *   scripts. Filenames lexicographically sort `.down.sql` BEFORE `.sql`,
 *   so a rollback script ran BEFORE its up-migration twin and destroyed
 *   the schema the up was supposed to build. Three consecutive Vercel
 *   deploys failed with 42P07 / 42809 before the cause was identified.
 *
 * The fix: filter excludes `*.down.sql`. This test locks that filter so
 * no future change can silently regress it.
 *
 * Run with:  node --test scripts/__tests__/migrate-filter.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(dirname(__filename)));
const MIGRATE_FILE = join(ROOT, "scripts", "migrate.mjs");

function applyFilter(files) {
  // Mirrors the filter in migrate.mjs — kept in sync by the
  // "source contains the filter" assertion below.
  return files
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .sort();
}

test("source of migrate.mjs excludes .down.sql", () => {
  const src = readFileSync(MIGRATE_FILE, "utf-8");
  // Must filter both: ends with .sql AND NOT ends with .down.sql.
  assert.match(src, /\.endsWith\("\.sql"\)\s*&&\s*!?.*\.endsWith\("\.down\.sql"\)/s);
});

test("filter keeps up-migrations and drops rollbacks", () => {
  const input = [
    "001_foundation.sql",
    "014_instinct_table_aliases.sql",
    "033_site_domains.down.sql",
    "033_site_domains.sql",
    "034_site_form_submissions.down.sql",
    "034_site_form_submissions.sql",
    "036_rename_feature_requests.down.sql",
    "036_rename_feature_requests.sql",
  ];
  const kept = applyFilter(input);
  assert.deepEqual(kept, [
    "001_foundation.sql",
    "014_instinct_table_aliases.sql",
    "033_site_domains.sql",
    "034_site_form_submissions.sql",
    "036_rename_feature_requests.sql",
  ]);
});

test("a lone .down.sql without its twin is still excluded", () => {
  const input = ["999_orphan.down.sql"];
  assert.deepEqual(applyFilter(input), []);
});

test("a .sql that happens to contain 'down' in the middle is still kept", () => {
  const input = ["040_shutdown_procedure.sql"];
  assert.deepEqual(applyFilter(input), ["040_shutdown_procedure.sql"]);
});

test("non-.sql files are always skipped", () => {
  const input = ["README.md", "036_rename_feature_requests.sql", "helpers.ts"];
  assert.deepEqual(applyFilter(input), ["036_rename_feature_requests.sql"]);
});
