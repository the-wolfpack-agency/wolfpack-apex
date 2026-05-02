/**
 * PostgreSQL connection pool for Wolfpack Instinct.
 *
 * Singleton pattern survives Next.js HMR. All queries parameterized.
 * Shadow mode: returns empty results when DATABASE_URL is not set.
 */

import { Pool, type PoolConfig, type QueryResult } from "pg";

/**
 * Normalize the connection string to explicitly request
 * `sslmode=verify-full`. pg-connection-string v3.0.0 / pg v9.0.0 will
 * change the meaning of `sslmode=require` (and `prefer` / `verify-ca`)
 * to libpq-compatible weaker semantics; the library currently emits
 * a SECURITY WARNING on every boot when those modes are seen. Setting
 * verify-full explicitly preserves today's strict-cert behaviour
 * across the upcoming upgrade and silences the warning.
 *
 * Pure for unit testing; returns undefined when input is undefined so
 * shadow mode keeps working.
 */
export function normalizeDatabaseUrlSsl(
  url: string | undefined,
): string | undefined {
  if (!url) return url;
  /* If sslmode is already verify-full, pass through unchanged. */
  if (/[?&]sslmode=verify-full(\b|&|$)/i.test(url)) return url;
  /* Replace any other sslmode value (require/prefer/verify-ca/disable). */
  if (/[?&]sslmode=[^&]+/i.test(url)) {
    return url.replace(/(?<=[?&])sslmode=[^&]+/i, "sslmode=verify-full");
  }
  /* No sslmode in URL — append. Pick the right separator based on
     whether a query string already exists. */
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}sslmode=verify-full`;
}

const normalizedUrl = normalizeDatabaseUrlSsl(process.env.DATABASE_URL);

const poolConfig: PoolConfig = {
  connectionString: normalizedUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  /* Explicit cert verification against the system CA store. Neon's
     certs are issued by public roots (Let's Encrypt / DigiCert) which
     are pre-trusted on Vercel's runtime. The previous
     `rejectUnauthorized: false` for Neon disabled cert validation
     entirely — a MITM exposure we no longer accept now that the URL
     itself requests verify-full. Set INSTINCT_DB_ALLOW_INSECURE=true
     ONLY as a break-glass if a cert rotation breaks prod. */
  ssl:
    normalizedUrl && process.env.INSTINCT_DB_ALLOW_INSECURE === "true"
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

/**
 * Thrown by writeQuery when a write fails or returns the wrong row count.
 * Distinct from pg errors so API routes can catch and surface cleanly.
 */
export class WriteQueryError extends Error {
  readonly code: "no_database" | "db_error" | "unexpected_row_count";
  readonly expected?: number;
  readonly actual?: number;
  constructor(
    message: string,
    code: WriteQueryError["code"],
    extra?: { expected?: number; actual?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "WriteQueryError";
    this.code = code;
    this.expected = extra?.expected;
    this.actual = extra?.actual;
  }
}

/**
 * Strict query helper for WRITES (INSERT / UPDATE / DELETE) where silent
 * failure is NEVER acceptable.
 *
 * Unlike safeQuery, this function:
 *   - THROWS WriteQueryError when DATABASE_URL is unset (shadow mode is
 *     not a valid state for writes).
 *   - THROWS WriteQueryError on any pg error — no silent swallow.
 *   - OPTIONALLY asserts the number of rows returned/affected. Pass
 *     `expectRows: 1` for an INSERT ... RETURNING that MUST produce
 *     exactly one row. If the count mismatches (e.g. the write was
 *     silently discarded by an auto-updatable view, an RLS policy, a
 *     trigger that rolled back, or anything else), the helper throws
 *     with both the expected and actual counts so the caller can log
 *     diagnostics.
 *
 * The whole reason this exists: a 200 response combined with a
 * silently-discarded write is the single most dangerous class of data
 * bug. Every write path that matters should go through writeQuery so
 * missing rows surface as errors, not as "the user typed it but nothing
 * happened."
 */
export async function writeQuery<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
  opts?: { expectRows?: number },
): Promise<{ rows: T[] }> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "writeQuery called without DATABASE_URL — writes require a real database.",
      "no_database",
    );
  }
  // Inner query requires a Record<string, unknown>-shaped generic; we
  // intersect T with it so callers can pass strict interfaces (like
  // FeatureRequest) without needing to declare an index signature.
  // Mirrors the pattern already used in safeQuery above.
  let result: QueryResult<T & Record<string, unknown>>;
  try {
    result = await query<T & Record<string, unknown>>(text, params);
  } catch (err) {
    throw new WriteQueryError(
      `writeQuery failed: ${(err as Error).message}`,
      "db_error",
      { cause: err },
    );
  }
  if (opts?.expectRows !== undefined && result.rows.length !== opts.expectRows) {
    throw new WriteQueryError(
      `writeQuery row-count mismatch: expected ${opts.expectRows}, got ${result.rows.length}`,
      "unexpected_row_count",
      { expected: opts.expectRows, actual: result.rows.length },
    );
  }
  return { rows: result.rows as T[] };
}
