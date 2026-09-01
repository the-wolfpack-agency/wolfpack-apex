/**
 * Reading a client's existing database without reading their data.
 *
 * The pitch for middleware is "plug in and we tell you something on the
 * first day." For a company whose center of gravity is a database older
 * than most of its staff, the first day is exactly when we know least:
 * no chains have run, no one has asked us anything.
 *
 * But the database has been keeping notes the whole time. Postgres
 * counts every sequential scan, every index scan, every insert, per
 * table, since the last stats reset — and with pg_stat_statements
 * installed it keeps the shape of every statement and what it cost.
 * None of that is our traffic. It is ALL traffic, including the
 * applications we will never be connected to, which is the one thing
 * our own connector telemetry can never see.
 *
 * WHAT THIS DELIBERATELY CANNOT DO
 *
 * There is no way to ask it for a row. Every statement it issues is a
 * fixed catalog query written in this file; nothing accepts SQL from
 * a caller, a model, or a tool parameter. It runs inside an explicitly
 * READ ONLY transaction with a short timeout, so even a mistake in this
 * file cannot write to a system we do not own.
 *
 * That is not only a safety posture, it is the commercial argument. A
 * client is far more likely to hand us a read-only role against the
 * production database if the honest answer to "what will you read" is
 * "your table names and your own performance counters, never a record."
 */

import type { Pool } from "pg";
import { getTenantPool, type PoolFactory } from "@/lib/db/pools";

/** Per-table activity, as the database itself has been counting it. */
export interface LegacyTableStat {
  table: string;
  /** Planner's live-row estimate. Never a COUNT(*) — that reads rows. */
  liveRows: number;
  seqScans: number;
  idxScans: number;
  writes: number;
  /**
   * Scans caused by maintenance rather than by anybody's query.
   *
   * ANALYZE reads the table, and autovacuum runs it on a schedule, so a
   * table that no application has ever touched still accumulates
   * sequential scans forever. Discovered by running this against a real
   * server: a table nothing had ever queried reported a scan, and the
   * "zero scans" rule that looked obvious against fixtures would have
   * fired on almost nothing in production.
   */
  analyses: number;
}

/** A normalized statement shape and what it has cost since the reset. */
export interface LegacyQueryShape {
  shape: string;
  calls: number;
  totalMs: number;
}

/**
 * One column, and whether the planner believes there is anything in it.
 *
 * null_frac comes from the planner's own sample, so knowing a column is
 * populated costs no rows read. When a table has never been analyzed
 * there is no sample and the fraction is unknown, which is reported as
 * unknown rather than assumed empty: claiming a column is dark when we
 * simply could not see it is the one mistake that would discredit the
 * whole analysis.
 */
export interface LegacyColumn {
  table: string;
  column: string;
  dataType: string;
  /** null when the table has never been analyzed. */
  nullFraction: number | null;
}

export interface LegacyScan {
  tables: LegacyTableStat[];
  columns: LegacyColumn[];
  shapes: LegacyQueryShape[];
  /**
   * False when pg_stat_statements is not installed. Reported rather
   * than hidden: "we could not see statement load" and "there is no
   * statement load" are different sentences, and only one of them is
   * ours to say.
   */
  statementStatsAvailable: boolean;
  /**
   * pg_stat_statements.track, when readable.
   *
   * The default is "top", which records only statements issued directly
   * by a client. Anything inside a function or a stored procedure is
   * invisible, and a legacy system of the kind this product is aimed at
   * is frequently almost entirely stored procedures. Reporting "no
   * repeated statements" on such a database would be a clean bill of
   * health we had no basis for, so the setting is read and declared.
   */
  statementTracking: string | null;
}

/** How many rows a table needs before "nobody reads it" is interesting. */
export const COLD_TABLE_MIN_ROWS = 1_000;

export function legacyDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.INSTINCT_LEGACY_DB_URL?.trim() || null;
}

export function legacyDatabaseName(env: NodeJS.ProcessEnv = process.env): string {
  return env.INSTINCT_LEGACY_DB_NAME?.trim() || "the legacy database";
}

/**
 * A statement shape is normalized by Postgres — literals become $1 —
 * but normalization is not a guarantee, and a shape is displayed to a
 * user and may end up in a screenshot or a ticket.
 *
 * So anything still quoted is removed before it leaves this file. A
 * shape with a customer's name in it is that customer's data, whatever
 * catalog it came out of.
 */
export function scrubShape(sql: string): string {
  const collapsed = sql
    .replace(/'[^']*'/g, "'?'")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

/* The whole SQL surface of this module. Fixed text, no interpolation,
   no caller input. Read them and you have read everything we can ask a
   client's database. */
const TABLE_STATS_SQL = `
  SELECT relname AS table,
         COALESCE(n_live_tup, 0)                                   AS live_rows,
         COALESCE(seq_scan, 0)                                     AS seq_scans,
         COALESCE(idx_scan, 0)                                     AS idx_scans,
         COALESCE(n_tup_ins, 0) + COALESCE(n_tup_upd, 0)
           + COALESCE(n_tup_del, 0)                                AS writes,
         COALESCE(analyze_count, 0) + COALESCE(autoanalyze_count, 0) AS analyses
  FROM pg_stat_user_tables
  ORDER BY COALESCE(n_live_tup, 0) DESC
  LIMIT 500`;

/* Every column in the database, with the planner's null fraction where
   one exists. information_schema is the portable catalog and pg_stats
   is the sample; neither reads a row of anybody's data. */
/*
 * BASE TABLE only. Against a real server this returned the columns of
 * the statement-statistics views themselves, so the analysis was
 * reporting on the monitoring extension we had just asked them to
 * install. A view has no rows of its own to be dark.
 *
 * The explanation lives here rather than inside the string: whatever is
 * in the string is sent to somebody else's database and recorded in
 * their statement statistics, and our commentary does not belong in
 * either.
 */
const COLUMN_STATS_SQL = `
  SELECT c.table_name  AS table,
         c.column_name AS column,
         c.data_type   AS data_type,
         s.null_frac   AS null_frac
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name   = c.table_name
   AND t.table_type   = 'BASE TABLE'
  LEFT JOIN pg_stats s
    ON s.schemaname = c.table_schema
   AND s.tablename  = c.table_name
   AND s.attname    = c.column_name
  WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
  ORDER BY c.table_name, c.ordinal_position
  LIMIT 5000`;

/* total_exec_time is PG13+; older servers call it total_time. Tried in
   that order so a modern server never pays for the fallback. */
const QUERY_SHAPES_SQL = `
  SELECT query AS shape, calls, total_exec_time AS total_ms
  FROM pg_stat_statements
  ORDER BY total_exec_time DESC
  LIMIT 50`;

const QUERY_SHAPES_LEGACY_SQL = `
  SELECT query AS shape, calls, total_time AS total_ms
  FROM pg_stat_statements
  ORDER BY total_time DESC
  LIMIT 50`;

const TRACK_SETTING_SQL = `SELECT current_setting('pg_stat_statements.track', true) AS track`;

/**
 * Our own catalog queries, which pg_stat_statements happily records.
 *
 * On a quiet database the busiest statements were OUR scan: the read
 * only transaction, the timeout, and the catalog selects. Reporting
 * those back to a client as their hot query load would be absurd, and
 * on a genuinely idle system it is what would have happened.
 */
function isOurOwnStatement(shape: string): boolean {
  return (
    /^(begin|commit|rollback|set\s+local)\b/i.test(shape) ||
    /pg_stat_user_tables|pg_stat_statements|information_schema\./i.test(shape)
  );
}

export interface ScanDeps {
  pool?: Pool;
  factory?: PoolFactory;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a fixed catalog query inside a read-only transaction.
 *
 * The transaction is the belt to the fixed-SQL braces. Postgres itself
 * refuses a write inside it, so the guarantee does not depend on this
 * file staying correct forever.
 */
async function readOnly<R>(pool: Pool, sql: string): Promise<R[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 8000");
    const res = await client.query(sql);
    await client.query("COMMIT");
    return (res.rows ?? []) as R[];
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is already gone; nothing to roll back */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Scan the client's database. Returns null when none is configured,
 * which is the ordinary case and not an error.
 */
export async function scanLegacyDatabase(deps: ScanDeps = {}): Promise<LegacyScan | null> {
  const env = deps.env ?? process.env;
  const url = legacyDatabaseUrl(env);
  if (!deps.pool && !url) return null;

  const pool =
    deps.pool ??
    getTenantPool(`legacy-source:${legacyDatabaseName(env)}`, url!, {
      factory: deps.factory,
      env,
      /* Opt-in, and deliberately two conditions rather than one: the
         operator sets the flag AND writes sslmode=disable into the URL.
         A client's legacy database frequently has no TLS at all, and
         the alternative to an explicit downgrade here is being unable
         to connect to the systems this product exists to connect to.
         Every database we own is unaffected. */
      allowPlaintext: env.INSTINCT_LEGACY_DB_ALLOW_PLAINTEXT === "true",
    });

  const rawTables = await readOnly<{
    table: string;
    live_rows: string | number;
    seq_scans: string | number;
    idx_scans: string | number;
    writes: string | number;
    analyses: string | number;
  }>(pool, TABLE_STATS_SQL);

  const tables: LegacyTableStat[] = rawTables.map((r) => ({
    table: String(r.table),
    liveRows: Number(r.live_rows) || 0,
    seqScans: Number(r.seq_scans) || 0,
    idxScans: Number(r.idx_scans) || 0,
    writes: Number(r.writes) || 0,
    analyses: Number(r.analyses) || 0,
  }));

  const rawColumns = await readOnly<{
    table: string;
    column: string;
    data_type: string;
    null_frac: number | string | null;
  }>(pool, COLUMN_STATS_SQL);

  const columns: LegacyColumn[] = rawColumns.map((r) => ({
    table: String(r.table),
    column: String(r.column),
    dataType: String(r.data_type ?? "unknown"),
    nullFraction: r.null_frac === null || r.null_frac === undefined ? null : Number(r.null_frac),
  }));

  let shapes: LegacyQueryShape[] = [];
  let statementStatsAvailable = true;
  try {
    let raw: Array<{ shape: string; calls: string | number; total_ms: string | number }>;
    try {
      raw = await readOnly(pool, QUERY_SHAPES_SQL);
    } catch {
      /* Pre-13 column name. If this fails too, the extension is absent
         rather than the server being old, and the catch below is the
         honest answer. */
      raw = await readOnly(pool, QUERY_SHAPES_LEGACY_SQL);
    }
    shapes = raw
      .map((r) => ({
        shape: scrubShape(String(r.shape ?? "")),
        calls: Number(r.calls) || 0,
        totalMs: Number(r.total_ms) || 0,
      }))
      .filter((q) => !isOurOwnStatement(q.shape));
  } catch {
    statementStatsAvailable = false;
  }

  let statementTracking: string | null = null;
  if (statementStatsAvailable) {
    try {
      const [row] = await readOnly<{ track: string | null }>(pool, TRACK_SETTING_SQL);
      statementTracking = row?.track ?? null;
    } catch {
      statementTracking = null;
    }
  }

  return { tables, columns, shapes, statementStatsAvailable, statementTracking };
}
