/**
 * SQL migration runner for Wolfpack Apex.
 * Usage: npx tsx src/db/migrate.ts
 */
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { pool } from "@/lib/db";
import { configuredTenants, dbMode, resolveTenant } from "@/lib/db/tenant";
import { getTenantPool, closeAllTenantPools } from "@/lib/db/pools";

const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

async function ensureMigrationsTable(db: Pool = pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(db: Pool = pool): Promise<Set<string>> {
  const result = await db.query("SELECT name FROM _migrations ORDER BY name");
  return new Set(result.rows.map((r: Record<string, unknown>) => r.name as string));
}

/**
 * A FORWARD migration is a `.sql` file that is NOT a `.down.sql` rollback.
 * Down files are rollback scripts run deliberately via `rollback()` — they
 * must never be picked up as forward migrations (doing so executed every
 * table's DROP as an apply, and only escaped breakage by sort-order luck +
 * `IF EXISTS`). Exported for the guard test.
 */
export function isForwardMigration(name: string): boolean {
  return name.endsWith(".sql") && !name.endsWith(".down.sql");
}

export function discoverMigrations(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter(isForwardMigration).sort();
}

/**
 * Deliberately roll back a single migration: apply its paired
 * `<name>.down.sql` and remove its `_migrations` row. This is the ONLY
 * path that executes a down file — never the forward `migrate()` loop.
 */
export async function rollback(name: string, db: Pool = pool): Promise<void> {
  if (!isForwardMigration(name)) {
    throw new Error(`[migrate] rollback expects a forward migration name, got: ${name}`);
  }
  const downName = name.replace(/\.sql$/, ".down.sql");
  const downPath = path.join(MIGRATIONS_DIR, downName);
  if (!fs.existsSync(downPath)) {
    throw new Error(`[migrate] No rollback file for ${name} (expected ${downName})`);
  }
  const sql = fs.readFileSync(downPath, "utf-8");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("DELETE FROM _migrations WHERE name = $1", [name]);
    await client.query("COMMIT");
    console.log(`[migrate] Rolled back: ${name}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`[migrate] Rollback failed ${name}: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

async function applyMigration(name: string, db: Pool = pool): Promise<void> {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
    await client.query("COMMIT");
    console.log(`[migrate] Applied: ${name}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`[migrate] Failed ${name}: ${(err as Error).message}`);
  } finally {
    client.release();
  }
}

export async function migrate(db: Pool = pool): Promise<void> {
  await ensureMigrationsTable(db);
  const applied = await getAppliedMigrations(db);
  const all = discoverMigrations();
  const pending = all.filter((n) => !applied.has(n));
  if (pending.length === 0) {
    console.log("[migrate] All migrations up to date.");
    return;
  }
  console.log(`[migrate] ${pending.length} pending...`);
  for (const name of pending) await applyMigration(name, db);
  console.log("[migrate] Done.");
}

if (require.main === module) {
  // `tsx src/db/migrate.ts`            → apply pending forward migrations
  // `tsx src/db/migrate.ts down <name>`→ roll back one migration deliberately
  const [cmd, name] = process.argv.slice(2);
  const run =
    cmd === "down"
      ? name
        ? rollback(name)
        : Promise.reject(new Error("[migrate] usage: down <migration-name.sql>"))
      : migrate();
  run.then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}

export interface TenantMigrationResult {
  tenantId: string;
  ok: boolean;
  error?: string;
}

/**
 * Apply migrations to EVERY configured client database.
 *
 * WHY IT CONTINUES AFTER A FAILURE
 *
 * Stopping on the first error leaves clients 1..6 migrated and 8..20 not, which
 * is the same split-brain as continuing — except you also do not know which of
 * the rest would have worked. So every tenant is attempted, every outcome is
 * collected, and the process exits non-zero if any failed. Rerunning is safe
 * and cheap: each database tracks its own _migrations rows, so a rerun applies
 * only what is still pending for that client.
 *
 * WHY IT REFUSES TO RUN IN SINGLE MODE
 *
 * In single mode there is one database and `migrate()` is the right entry
 * point. Fanning out over zero configured tenants would print "0 tenants
 * migrated" and exit successfully, which reads exactly like a completed run.
 */
export async function migrateAllTenants(): Promise<TenantMigrationResult[]> {
  if (dbMode() !== "routed") {
    throw new Error(
      "[migrate] migrateAllTenants requires INSTINCT_DB_MODE=routed. In single mode use migrate().",
    );
  }
  const tenants = configuredTenants();
  if (tenants.length === 0) {
    // Loud, because a silent success here means nobody's database got migrated.
    throw new Error("[migrate] routed mode is on but no INSTINCT_TENANT_DB_* variables are set — nothing to migrate.");
  }

  const results: TenantMigrationResult[] = [];
  for (const tenantId of tenants) {
    try {
      const { connectionString } = resolveTenant(tenantId);
      const db = getTenantPool(tenantId, connectionString);
      console.log(`[migrate] --- ${tenantId} ---`);
      await migrate(db);
      results.push({ tenantId, ok: true });
    } catch (err) {
      const error = (err as Error).message;
      console.error(`[migrate] FAILED for ${tenantId}: ${error}`);
      results.push({ tenantId, ok: false, error });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`[migrate] ${results.length - failed.length}/${results.length} tenant database(s) migrated.`);
  if (failed.length > 0) {
    // Named individually: "3 failed" sends someone reading logs, the names send
    // them to the right client.
    console.error(`[migrate] still behind: ${failed.map((f) => f.tenantId).join(", ")}`);
  }
  await closeAllTenantPools();
  return results;
}
