/**
 * scripts/migration-database-url.cjs - which connection schema work runs as.
 *
 * Migrations (scripts/migrate.mjs), the upsert-target check and the wiki seed
 * run at build time and need the table OWNER: a non-owner cannot ALTER TABLE,
 * and the RLS policies would hide rows from an unscoped seed. Once the RLS
 * cutover points DATABASE_URL at the non-owner app role
 * (docs/security/rls-cutover.md), MIGRATION_DATABASE_URL carries the owner.
 *
 * Unset or blank: falls back to DATABASE_URL, so nothing changes until the
 * operator sets it. Plain JS so migrate.mjs (no TS) and the tsx scripts share
 * one rule. CommonJS so Jest and plain Node both load it as is.
 */
"use strict";

/** The owner connection for schema work: MIGRATION_DATABASE_URL, else DATABASE_URL. */
function migrationDatabaseUrl(env = process.env) {
  const m = (env.MIGRATION_DATABASE_URL ?? "").trim();
  if (m) return m;
  const d = (env.DATABASE_URL ?? "").trim();
  return d || undefined;
}

/**
 * For scripts that go through the app's pool (src/lib/db.ts reads
 * DATABASE_URL when it is first imported): point DATABASE_URL at the
 * migration connection for THIS process only. Import before anything that
 * imports @/lib/db. Returns the URL in use, or undefined (shadow mode).
 */
function applyMigrationDatabaseUrl(env = process.env) {
  const url = migrationDatabaseUrl(env);
  if (url) env.DATABASE_URL = url;
  return url;
}

module.exports = { migrationDatabaseUrl, applyMigrationDatabaseUrl };
