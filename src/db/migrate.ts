/**
 * SQL migration runner for Wolfpack Apex.
 * Usage: npx tsx src/db/migrate.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pool } from "@/lib/db";

const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const result = await pool.query("SELECT name FROM _migrations ORDER BY name");
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
export async function rollback(name: string): Promise<void> {
  if (!isForwardMigration(name)) {
    throw new Error(`[migrate] rollback expects a forward migration name, got: ${name}`);
  }
  const downName = name.replace(/\.sql$/, ".down.sql");
  const downPath = path.join(MIGRATIONS_DIR, downName);
  if (!fs.existsSync(downPath)) {
    throw new Error(`[migrate] No rollback file for ${name} (expected ${downName})`);
  }
  const sql = fs.readFileSync(downPath, "utf-8");
  const client = await pool.connect();
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

async function applyMigration(name: string): Promise<void> {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf-8");
  const client = await pool.connect();
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

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const all = discoverMigrations();
  const pending = all.filter((n) => !applied.has(n));
  if (pending.length === 0) {
    console.log("[migrate] All migrations up to date.");
    return;
  }
  console.log(`[migrate] ${pending.length} pending...`);
  for (const name of pending) await applyMigration(name);
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
