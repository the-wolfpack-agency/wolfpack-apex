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

function discoverMigrations(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
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
  migrate().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
