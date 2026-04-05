/**
 * PostgreSQL connection pool for Wolfpack Apex.
 *
 * Singleton pattern survives Next.js HMR. All queries parameterized.
 * Shadow mode: returns empty results when DATABASE_URL is not set.
 */

import { Pool, type PoolConfig, type QueryResult } from "pg";

const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  ssl: process.env.DATABASE_URL?.includes("neon")
    ? { rejectUnauthorized: false }
    : undefined,
};

function createPool(): Pool {
  const g = globalThis as unknown as { __pgPool?: Pool };
  if (!g.__pgPool) {
    g.__pgPool = new Pool(poolConfig);
    g.__pgPool.on("error", (err) => {
      console.error("[db] Pool error:", err.message);
    });
  }
  return g.__pgPool;
}

export const pool = createPool();

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function safeQuery<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; fromCache: boolean }> {
  if (!process.env.DATABASE_URL) {
    return { rows: [], fromCache: true };
  }
  try {
    const result = await query<T & Record<string, unknown>>(text, params);
    return { rows: result.rows, fromCache: false };
  } catch (err) {
    console.warn("[db] Query failed:", (err as Error).message);
    return { rows: [], fromCache: true };
  }
}
