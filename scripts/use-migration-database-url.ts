/**
 * Side-effect import: point DATABASE_URL at MIGRATION_DATABASE_URL (when set)
 * for this process, before @/lib/db creates its pool. Same ordering rule as
 * ./load-env, and it must come right after it:
 *
 *     import "./load-env";
 *     import "./use-migration-database-url";
 *     ...then anything that reaches the app's database pool.
 */
import { applyMigrationDatabaseUrl } from "./migration-database-url.cjs";

applyMigrationDatabaseUrl();
