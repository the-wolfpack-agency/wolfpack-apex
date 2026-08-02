/**
 * PostgreSQL connection pool for Wolfpack Instinct.
 *
 * Singleton pattern survives Next.js HMR. All queries parameterized.
 * Shadow mode: returns empty results when DATABASE_URL is not set.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";
import { normalizeDatabaseUrlSsl } from "@/lib/db-url";
import { connectionStringFor, dbMode, TenantResolutionError } from "@/lib/db/tenant";
import { getTenantPool } from "@/lib/db/pools";

export { normalizeDatabaseUrlSsl };


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

/**
 * Per-request workspace scope (the session-var RLS retrofit's foundation).
 *
 * `withWorkspaceScope(workspaceId, fn)` checks out ONE pooled client, opens a
 * transaction, sets the `app.workspace_id` GUC (transaction-local), and runs
 * `fn` inside an AsyncLocalStorage context that pins that client. While inside,
 * `query` / `safeQuery` / `writeQuery` transparently run on that same client, so
 * a Postgres RLS policy keyed on `current_setting('app.workspace_id')` filters
 * every row WITHOUT each call site having to thread a client param.
 *
 * AsyncLocalStorage (Node's async-context primitive — the same mechanism Prisma,
 * Knex, and OpenTelemetry use for ambient request context) was chosen over the
 * alternatives deliberately: threading an explicit client through every store
 * function is enormous churn and one missed argument silently bypasses RLS;
 * a request-global variable cannot work with a connection pool (the GUC must
 * live on the SAME checked-out client as the query, inside the same tx). ALS
 * gives a safe default — OUTSIDE a scope `query` uses the pool exactly as before
 * — with zero call-site churn.
 */
interface WorkspaceScope {
  workspaceId: string;
  client: PoolClient;
}
const scopeStore = new AsyncLocalStorage<WorkspaceScope>();

/**
 * WHICH DATABASE THIS REQUEST BELONGS TO.
 *
 * Instinct is sold per client and each client gets their own database, so the
 * boundary between two companies is the database rather than a predicate. That
 * only holds if the database is chosen from something the caller cannot
 * influence, which is why withTenant() is the only door and it takes a tenant
 * id the caller has already verified from the session.
 *
 * Separate from the workspace scope on purpose. A workspace separates teams
 * INSIDE one client's database; a tenant separates clients. Conflating them
 * would mean a workspace id from a request body could pick a database.
 */
const tenantStore = new AsyncLocalStorage<{ tenantId: string }>();

/** The tenant this request resolved to, if any. */
export function activeTenant(): string | undefined {
  return tenantStore.getStore()?.tenantId;
}

/**
 * Run `fn` against one client's database.
 *
 * The tenant id MUST come from the verified session claim. Never from a
 * subdomain, header, body field or query parameter — that is the single way
 * this architecture fails as badly as a shared database would, and no code
 * below this line can tell the difference, so the route-layer guardrail
 * enforces it instead.
 *
 * Nesting to a DIFFERENT tenant throws. A request that has begun reading one
 * client's data has no legitimate reason to reach into another's, and the
 * alternative — quietly using the inner or outer one — is a coin flip over
 * whose data gets returned.
 */
export async function withTenant<R>(tenantId: string, fn: () => Promise<R>): Promise<R> {
  const existing = tenantStore.getStore();
  if (existing) {
    if (existing.tenantId !== tenantId) {
      throw new TenantResolutionError(
        `tenant nesting mismatch: already serving '${existing.tenantId}', refused re-scope to '${tenantId}'`,
      );
    }
    return fn();
  }
  return tenantStore.run({ tenantId }, fn);
}

/**
 * The pool this request must use.
 *
 * In single mode this is the process-wide pool and nothing changes. In routed
 * mode it is the tenant's pool, and a request with no tenant in scope THROWS
 * rather than falling back — a fallback would turn every bug that loses the
 * tenant into a successful, silent read of another client's data.
 */
/**
 * Is a database reachable for THIS request?
 *
 * Shadow mode keyed on DATABASE_URL alone was correct when there was one
 * database. In routed mode DATABASE_URL is legitimately unset while every
 * tenant has their own, so the old check would have put the entire product into
 * shadow mode and returned empty rows for everything — silently, and looking
 * exactly like a client with no data.
 */
export function hasDatabase(): boolean {
  if (dbMode() === "single") return Boolean(process.env.DATABASE_URL);
  try {
    return Boolean(connectionStringFor(activeTenant()));
  } catch {
    return false;
  }
}

export function activePool(): Pool {
  if (dbMode() === "single") return pool;
  const tenantId = activeTenant();
  const connectionString = connectionStringFor(tenantId);
  if (!connectionString) {
    throw new TenantResolutionError("routed mode resolved no connection string");
  }
  return getTenantPool(tenantId as string, connectionString);
}

/** The active workspace scope, if the caller is inside withWorkspaceScope. */
export function activeWorkspaceScope(): { workspaceId: string } | undefined {
  const s = scopeStore.getStore();
  return s ? { workspaceId: s.workspaceId } : undefined;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  // Inside a workspace scope, run on the scoped tx client so RLS sees the GUC.
  // Outside (the default everywhere today), use the pool exactly as before.
  const scope = scopeStore.getStore();
  return (scope ? scope.client : activePool()).query<T>(text, params);
}

export async function safeQuery<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; fromCache: boolean }> {
  if (!hasDatabase()) {
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
  readonly code:
    | "no_database"
    | "db_error"
    | "unexpected_row_count"
    /* Used by syncPrinciplesFromParsed to refuse mass-retirement when
       the parsed input is empty. Distinct from db_error so callers can
       surface the right "parser failure" diagnostic instead of a
       generic write error. */
    | "empty_parsed_set";
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
  if (!hasDatabase()) {
    throw new WriteQueryError(
      "writeQuery called with no database for this request — writes require a real database, and in routed mode a resolved tenant.",
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

/**
 * A single-statement strict write bound to ONE transaction client. Same
 * semantics as the top-level writeQuery (throws WriteQueryError on a pg error
 * and on an `expectRows` mismatch), but every call runs on the same connection
 * inside the open BEGIN/COMMIT so a mid-sequence failure ROLLs BACK the whole
 * unit of work instead of leaving an orphaned partial write. This is the seam
 * that makes a multi-row write (e.g. a scan header + its findings) all-or-nothing.
 */
export interface TxClient {
  write<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
    opts?: { expectRows?: number },
  ): Promise<{ rows: T[] }>;
}

/**
 * Run `fn` inside a single Postgres transaction. BEGIN before `fn`, COMMIT if it
 * resolves, ROLLBACK if it throws (and the original error is re-thrown so the
 * caller can surface it). The client is always released back to the pool.
 *
 * Why this exists: a sequence of separate writeQuery calls is NOT atomic — a
 * failure partway through leaves earlier rows committed while the caller is told
 * the operation failed (or, worse, told it succeeded with a zeroed count). Wrap
 * any multi-write durable operation in withTransaction so it is all-or-nothing.
 *
 * Mirrors writeQuery's shadow-mode contract: throws WriteQueryError("no_database")
 * when DATABASE_URL is unset, because a transactional WRITE in shadow mode is not
 * a valid state — silently no-op'ing a write is the exact data-loss class this
 * module exists to prevent.
 */
export async function withTransaction<R>(
  fn: (tx: TxClient) => Promise<R>,
): Promise<R> {
  if (!hasDatabase()) {
    throw new WriteQueryError(
      "withTransaction called with no database for this request — writes require a real database, and in routed mode a resolved tenant.",
      "no_database",
    );
  }
  // activePool(), not the process pool: a transaction that opened against the
  // wrong database is precisely the failure this whole design exists to stop,
  // and it would commit successfully.
  const client: PoolClient = await activePool().connect();
  const tx: TxClient = {
    async write<T = Record<string, unknown>>(
      text: string,
      params?: unknown[],
      opts?: { expectRows?: number },
    ): Promise<{ rows: T[] }> {
      let result: QueryResult<T & Record<string, unknown>>;
      try {
        result = await client.query<T & Record<string, unknown>>(text, params);
      } catch (err) {
        throw new WriteQueryError(
          `withTransaction write failed: ${(err as Error).message}`,
          "db_error",
          { cause: err },
        );
      }
      if (opts?.expectRows !== undefined && result.rows.length !== opts.expectRows) {
        throw new WriteQueryError(
          `withTransaction row-count mismatch: expected ${opts.expectRows}, got ${result.rows.length}`,
          "unexpected_row_count",
          { expected: opts.expectRows, actual: result.rows.length },
        );
      }
      return { rows: result.rows as T[] };
    },
  };
  try {
    await client.query("BEGIN");
    const out = await fn(tx);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      // A rollback failure must not mask the original error; log + continue.
      console.warn("[db] ROLLBACK failed:", (rbErr as Error).message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` with every `query` / `safeQuery` / `writeQuery` call scoped to one
 * workspace via a transaction-local `app.workspace_id` GUC. This is the seam a
 * real (FORCE) row-level-security policy keyed on
 * `current_setting('app.workspace_id', true)` hangs off — the predicate and the
 * policy then BOTH hold (defense in depth). See docs/tenant-isolation.md.
 *
 * Contracts:
 *   - Shadow mode (no DATABASE_URL): runs `fn` directly with NO scoped client, so
 *     reads still no-op through safeQuery exactly as today. A transactional
 *     write in shadow mode is still rejected by writeQuery (no_database).
 *   - Nesting: re-entering with the SAME workspaceId reuses the open scope (no
 *     second connection). Re-entering with a DIFFERENT workspaceId throws — a
 *     cross-tenant nesting is always a bug, never silently honored.
 *   - The client is ALWAYS released; COMMIT on success, ROLLBACK + re-throw on
 *     failure (mirrors withTransaction).
 *
 * NOTE: withTransaction() opens its OWN connection and is NOT yet scope-aware, so
 * a multi-write atomic block does not inherit the GUC. Until that is unified,
 * keep FORCE-RLS tables off the withTransaction path (they use writeQuery, which
 * IS scope-aware). Tracked in docs/tenant-isolation.md.
 */
export async function withWorkspaceScope<R>(
  workspaceId: string,
  fn: () => Promise<R>,
): Promise<R> {
  if (!workspaceId) {
    throw new Error("withWorkspaceScope requires a non-empty workspaceId");
  }
  const existing = scopeStore.getStore();
  if (existing) {
    if (existing.workspaceId !== workspaceId) {
      throw new Error(
        `withWorkspaceScope nesting mismatch: already scoped to '${existing.workspaceId}', refused re-scope to '${workspaceId}'`,
      );
    }
    // Already scoped to the same workspace on an open client — just run.
    return fn();
  }
  // Shadow mode: no DB for this request. Run fn with pool/shadow semantics.
  if (!hasDatabase()) {
    return fn();
  }
  const client: PoolClient = await activePool().connect();
  try {
    await client.query("BEGIN");
    // set_config(name, value, is_local=true) is the parameterized form of
    // `SET LOCAL` (SET LOCAL cannot bind a parameter). Transaction-scoped, reset
    // automatically on COMMIT/ROLLBACK + client release.
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    const out = await scopeStore.run({ workspaceId, client }, fn);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      console.warn("[db] ROLLBACK failed:", (rbErr as Error).message);
    }
    throw err;
  } finally {
    client.release();
  }
}
