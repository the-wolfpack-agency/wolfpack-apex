/**
 * Guard: no two FORWARD migrations may share a number prefix.
 *
 * How the runner treats same-numbered files (scripts/migrate.mjs, the deploy
 * runner, and discoverMigrations() in src/db/migrate.ts): it lists every
 * `*.sql` that is not `*.down.sql` and sorts the FULL file names with the
 * default JavaScript sort (UTF-16 code-unit order). Applied state is keyed by
 * the full file name in `_migrations.name` (UNIQUE), never by the number. So two
 * files numbered 290 both apply, in name order (`290_ai_...` before
 * `290_forcefield_...`), and neither blocks the other. The number therefore does
 * not decide ordering against a same-numbered sibling: the rest of the name does,
 * which is an accident waiting to happen when one depends on the other. Hence
 * this guard for every NEW migration.
 *
 * ALLOWLIST (do not extend without a reason of the same kind): numbers whose
 * duplicates are ALREADY APPLIED in production. Renaming or renumbering an
 * applied file would make the runner see a new name and re-run it, so they stay.
 * Verified read-only against the production `_migrations` ledger on 2026-10-25:
 *   - 290: `290_ai_code_watch_parked.sql` (applied 2026-10-18, file not on main)
 *          and `290_forcefield_block_expiry.sql` (applied 2026-10-24).
 *   - 273: `273_ai_code_watched_repos.sql` and `273_repo_baseline.sql` (the
 *          latter from branch feat/onboarding-baseline-snapshot, not on main).
 * Each entry pins the EXACT file names, so a third file at 290 or 273 still fails.
 * `.down.sql` rollback files are not forward migrations and are ignored.
 */
import { discoverMigrations } from "@/db/migrate";

jest.mock("@/lib/db", () => ({ pool: { connect: jest.fn() }, activePool: () => ({ connect: jest.fn() }) }));

const APPLIED_DUPLICATE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "273": ["273_ai_code_watched_repos.sql", "273_repo_baseline.sql"],
  "290": ["290_ai_code_watch_parked.sql", "290_forcefield_block_expiry.sql"],
};

function duplicateMigrationViolations(files: readonly string[], allow: Readonly<Record<string, readonly string[]>> = APPLIED_DUPLICATE_ALLOWLIST): string[] {
  const byNumber = new Map<string, string[]>();
  for (const f of files) {
    const m = /^(\d+)_/.exec(f);
    if (!m) continue;
    byNumber.set(m[1], [...(byNumber.get(m[1]) ?? []), f]);
  }
  const out: string[] = [];
  for (const [n, group] of byNumber) {
    if (group.length < 2) continue;
    const allowed = new Set(allow[n] ?? []);
    const extra = group.filter((f) => !allowed.has(f));
    if (extra.length) out.push(`${n}: ${group.join(", ")} (not allowlisted: ${extra.join(", ")})`);
  }
  return out;
}

describe("migration numbers are unique", () => {
  test("no NEW duplicate migration number in src/db/migrations", () => {
    expect(duplicateMigrationViolations(discoverMigrations())).toEqual([]);
  });

  test("every forward migration has a numeric prefix", () => {
    expect(discoverMigrations().filter((f) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(f))).toEqual([]);
  });

  test("the guard fails a new duplicate, including a third file on an allowlisted number", () => {
    expect(duplicateMigrationViolations(["300_a.sql", "300_b.sql"])).toHaveLength(1);
    expect(duplicateMigrationViolations(["290_forcefield_block_expiry.sql", "290_ai_code_watch_parked.sql"])).toEqual([]);
    expect(duplicateMigrationViolations(["290_forcefield_block_expiry.sql", "290_new_thing.sql"])[0]).toContain("290_new_thing.sql");
  });

  test("the runner orders same-numbered files by full name, as documented", () => {
    expect(["290_forcefield_block_expiry.sql", "290_ai_code_watch_parked.sql"].sort()).toEqual([
      "290_ai_code_watch_parked.sql",
      "290_forcefield_block_expiry.sql",
    ]);
  });
});
