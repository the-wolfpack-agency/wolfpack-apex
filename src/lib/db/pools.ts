/**
 * One connection pool per tenant, created lazily and bounded.
 *
 * WHY BOUNDED
 *
 * A serverless function that opens a pool per tenant and never closes one will
 * exhaust Neon's per-project connection cap, and the failure arrives as
 * intermittent "too many connections" on whichever client happens to be next —
 * an outage that looks random and is not.
 *
 * So pools are cached with a hard cap and least-recently-used eviction. An
 * evicted pool is drained in the background rather than destroyed under a
 * caller: `pool.end()` waits for checked-out clients to be released, so a
 * request already using it finishes normally.
 *
 * WHY LAZY
 *
 * A deployment may be configured for twenty tenants and serve one of them in a
 * given function instance. Connecting to twenty databases at boot would pay the
 * cost of all of them and stall the cold start.
 *
 * The pg options mirror src/lib/db.ts exactly, including the TLS posture: the
 * per-tenant path must not be quietly weaker than the single-database path,
 * which is the sort of asymmetry that only shows up in an incident.
 */
import { Pool, type PoolConfig } from "pg";
import { normalizeDatabaseUrlSsl } from "@/lib/db-url";

/**
 * How many tenant pools one function instance keeps open.
 *
 * Small on purpose. Serverless instances are numerous and short-lived, so the
 * risk is many instances each holding many pools, not one instance holding too
 * few. Raising this trades connection headroom for fewer reconnects.
 */
export const MAX_TENANT_POOLS = 4;

interface Entry {
  pool: Pool;
  lastUsedAt: number;
}

/** Survives HMR in dev, mirroring the singleton in src/lib/db.ts. */
function cache(): Map<string, Entry> {
  const g = globalThis as unknown as { __tenantPools?: Map<string, Entry> };
  if (!g.__tenantPools) g.__tenantPools = new Map();
  return g.__tenantPools;
}

export function poolConfigFor(connectionString: string, env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const normalized = normalizeDatabaseUrlSsl(connectionString);
  return {
    connectionString: normalized,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    // Same break-glass as the single-database path, and the same default of
    // full verification. A per-tenant pool that silently skipped cert checks
    // would be a downgrade nobody asked for.
    ssl: env.INSTINCT_DB_ALLOW_INSECURE === "true" ? { rejectUnauthorized: false } : undefined,
  };
}

/** Injectable so tests never open a socket. */
export type PoolFactory = (config: PoolConfig) => Pool;

const defaultFactory: PoolFactory = (config) => {
  const p = new Pool(config);
  p.on("error", (err) => console.error("[db] tenant pool error:", err.message));
  return p;
};

export function getTenantPool(
  tenantId: string,
  connectionString: string,
  deps: { factory?: PoolFactory; now?: () => number; env?: NodeJS.ProcessEnv } = {},
): Pool {
  const factory = deps.factory ?? defaultFactory;
  const now = deps.now ?? Date.now;
  const pools = cache();

  const existing = pools.get(tenantId);
  if (existing) {
    existing.lastUsedAt = now();
    return existing.pool;
  }

  // Evict BEFORE inserting, so the cap is a cap rather than a suggestion.
  while (pools.size >= MAX_TENANT_POOLS) {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of pools) {
      if (entry.lastUsedAt < oldest) {
        oldest = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const evicted = pools.get(oldestKey)!;
    pools.delete(oldestKey);
    // Drain, do not destroy: end() resolves once checked-out clients are
    // released, so a request mid-query finishes rather than losing its
    // connection. Failures are logged and swallowed — an eviction problem must
    // not surface as an error on an unrelated request.
    void evicted.pool.end().catch((err) => console.warn("[db] draining evicted tenant pool:", (err as Error).message));
  }

  const created = factory(poolConfigFor(connectionString, deps.env));
  pools.set(tenantId, { pool: created, lastUsedAt: now() });
  return created;
}

/** Tenants with an open pool in this instance. Diagnostics only. */
export function openTenantPools(): string[] {
  return [...cache().keys()].sort();
}

/** Drain everything. For tests and for a graceful shutdown. */
export async function closeAllTenantPools(): Promise<void> {
  const pools = cache();
  const entries = [...pools.values()];
  pools.clear();
  await Promise.allSettled(entries.map((e) => e.pool.end()));
}
