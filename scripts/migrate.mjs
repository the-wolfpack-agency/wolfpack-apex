#!/usr/bin/env node
/**
 * scripts/migrate.mjs — production-safe SQL migration runner.
 *
 * Plain Node + pg, no TS, no path aliases. Wired into vercel-build so
 * every Vercel deploy applies pending migrations before next build runs.
 * Idempotent: tracks applied migrations in _migrations table and skips
 * anything already applied. Atomic: each migration runs inside a tx.
 *
 * If DATABASE_URL is unset, this script no-ops with a warning so local
 * builds and shadow-mode dev environments don't break.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));
const DIR = join(ROOT, "src", "db", "migrations");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.warn("[migrate] DATABASE_URL not set — skipping (shadow mode).");
    return;
  }
  if (!existsSync(DIR)) {
    console.log("[migrate] no migrations dir, nothing to do");
    return;
  }
  const ssl = process.env.DATABASE_URL.includes("neon")
    ? { rejectUnauthorized: false }
    : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set(
    (await pool.query("SELECT name FROM _migrations")).rows.map((r) => r.name),
  );

  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(DIR, f), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`[migrate] applied ${f}`);
      count++;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[migrate] FAILED ${f}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
  await pool.end();
  console.log(`[migrate] done (${count} new, ${applied.size} previously applied)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
