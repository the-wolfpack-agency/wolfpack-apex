/**
 * Ratchet: runtime code must not reach the raw pool.
 *
 * Instinct is sold per client with a database each, and `activePool()` is what
 * picks the right one. Importing the raw `pool` export bypasses that entirely
 * and talks to whichever database the process booted with — which, in routed
 * mode, is nobody's.
 *
 * This is not hypothetical: nine files imported `pool` directly when routing
 * was introduced, including the audit log and the OGIAM ledger. Every one of
 * them would have written a client's records into the wrong database, silently
 * and successfully, because the query itself is perfectly valid.
 *
 * WHY A RATCHET AND NOT A DELETED EXPORT
 *
 * The raw pool is still correct for code that runs OUTSIDE a request and has no
 * tenant to belong to: the migration runner and the seeder. Deleting the export
 * would leave those without a way to connect. So it stays, and this makes using
 * it a decision rather than an autocomplete.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..");

/**
 * Files allowed to import the raw pool, with the reason each is safe.
 *
 * The bar: the code cannot run inside a request, so there is no tenant it could
 * belong to. Anything else must use activePool().
 */
const RAW_POOL_OK: Readonly<Record<string, string>> = {
  "db/migrate.ts":
    "The migration runner. Runs from a script with no request and no session, and in routed mode fans out per tenant explicitly rather than inheriting one.",
  "db/seed-knowledge.ts": "Seed script. Runs from the command line, never inside a request.",
};

/** `pool` imported from the db module, in any of the shapes people write. */
const IMPORTS_RAW_POOL = /import\s*\{[^}]*\bpool\b[^}]*\}\s*from\s*["'](?:@\/lib\/db|\.\.?\/[^"']*\/db|\.\.?\/db)["']/;

function walk(dir: string, prefix: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "__mocks__" || entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) walk(abs, rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe("runtime code routes through activePool", () => {
  const files = [...walk(join(SRC, "lib"), "lib"), ...walk(join(SRC, "app"), "app"), ...walk(join(SRC, "db"), "db")];
  const offenders = files.filter((rel) => IMPORTS_RAW_POOL.test(readFileSync(join(SRC, rel), "utf-8"))).sort();

  it("scans a meaningful number of files, so a broken walk cannot pass by finding nothing", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("catches the import shapes people actually write", () => {
    // A guardrail nobody has watched fire is a guardrail nobody knows works.
    expect(IMPORTS_RAW_POOL.test('import { pool } from "@/lib/db";')).toBe(true);
    expect(IMPORTS_RAW_POOL.test('import { pool, safeQuery } from "@/lib/db";')).toBe(true);
    expect(IMPORTS_RAW_POOL.test('import { safeQuery, pool } from "@/lib/db";')).toBe(true);
  });

  it("does not fire on things that merely contain the word", () => {
    // Noise is how a guardrail gets switched off.
    expect(IMPORTS_RAW_POOL.test('import { activePool } from "@/lib/db";')).toBe(false);
    expect(IMPORTS_RAW_POOL.test('import { getTenantPool } from "@/lib/db/pools";')).toBe(false);
    expect(IMPORTS_RAW_POOL.test('// the pool is shared')).toBe(false);
  });

  it("has no unlisted file importing the raw pool", () => {
    const unlisted = offenders.filter((f) => !(f in RAW_POOL_OK));
    expect({
      hint: "Use activePool() so the query reaches the right client's database. The raw pool is only for code that runs outside a request.",
      unlisted,
    }).toEqual({ hint: expect.any(String), unlisted: [] });
  });

  it("has no stale allow-list entry", () => {
    const stale = Object.keys(RAW_POOL_OK).filter((f) => !offenders.includes(f));
    expect({ hint: "No longer imports the raw pool. Remove it from RAW_POOL_OK.", stale }).toEqual({
      hint: expect.any(String),
      stale: [],
    });
  });
});
