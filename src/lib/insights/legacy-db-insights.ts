/**
 * What a client's own database already knows about itself.
 *
 * These three generators share a property none of the others have:
 * they describe load that we did not cause. Connector telemetry can
 * only ever see the requests we issue, which on the first day is none
 * and on a normal day is a slice. Postgres has been counting all of it
 * the whole time, for every application in the building, including the
 * ones nobody remembers deploying.
 *
 * Everything here is arithmetic over counters, and none of it reads a
 * customer record. See sources/legacy-postgres.ts for why that limit is
 * the commercial argument rather than a constraint on it.
 */

import type { CrossToolInsight, InsightContext } from "./cross-tool-generators";
import {
  COLD_TABLE_MIN_ROWS,
  legacyDatabaseName,
  scanLegacyDatabase,
  type LegacyScan,
} from "@/lib/sources/legacy-postgres";

/** A shape has to be asked this often before repetition is the story. */
const REPEAT_CALL_THRESHOLD = 1_000;

async function scan(): Promise<LegacyScan | null> {
  try {
    return await scanLegacyDatabase();
  } catch {
    /* An unreachable client database must never take the insight panel
       down. The other generators still have things to say. */
    return null;
  }
}

/* ── Tables holding data nobody reads ─────────────────────────────── */

/**
 * A table with a million rows and zero scans since the stats reset is
 * being backed up, replicated, migrated and paid for, and read by
 * nothing.
 *
 * This is worth saying carefully. Zero scans does not prove the data is
 * dead: the counters reset, and a quarterly report is invisible in a
 * fortnight's window. So the finding is framed as a question with the
 * evidence attached, which is also the only framing a DBA will not
 * dismiss on sight.
 */
export async function generateColdTables(
  _ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  const s = await scan();
  if (!s) return [];

  const cold = s.tables
    .filter(
      (t) =>
        t.liveRows >= COLD_TABLE_MIN_ROWS && t.seqScans === 0 && t.idxScans === 0,
    )
    .sort((a, b) => b.liveRows - a.liveRows)
    .slice(0, 5);
  if (cold.length === 0) return [];

  const rows = cold.reduce((n, t) => n + t.liveRows, 0);
  const written = cold.filter((t) => t.writes > 0);

  return [
    {
      id: "legacy_cold_tables",
      generator: "legacy_cold_tables",
      severity: cold.length >= 3 ? "medium" : "low",
      signalStrength: Math.min(100, 40 + cold.length * 10),
      title: `${cold.length} large tables in ${legacyDatabaseName()} have not been read`,
      detail:
        `${cold.map((t) => t.table).join(", ")} hold about ${rows.toLocaleString()} rows ` +
        `between them and have recorded no scans of any kind since the statistics were ` +
        `last reset` +
        (written.length
          ? `, though ${written.length} of them are still being written to — something is ` +
            `filling them and nothing is reading them.`
          : `. Worth confirming against a longer window before anything is retired.`),
      action: { label: "Check what still writes to these", chip: "cross-source insights" },
      sources: ["legacy-database"],
    },
  ];
}

/* ── Where the reads actually go ──────────────────────────────────── */

/**
 * Almost every old database turns out to be two or three tables and a
 * long tail. Nobody in the building has seen it stated, because the
 * counters are per-table and the ratio only appears when you add them
 * up.
 *
 * It is the most useful sentence we can offer before a migration:
 * whatever else is true, those tables are the system.
 */
export async function generateReadConcentration(
  _ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  const s = await scan();
  if (!s) return [];

  const withReads = s.tables
    .map((t) => ({ ...t, reads: t.seqScans + t.idxScans }))
    .filter((t) => t.reads > 0)
    .sort((a, b) => b.reads - a.reads);
  /* Below a handful of tables there is no concentration to report,
     only a small database. */
  if (withReads.length < 5) return [];

  const total = withReads.reduce((n, t) => n + t.reads, 0);
  if (total === 0) return [];

  const top = withReads.slice(0, 3);
  const share = Math.round((top.reduce((n, t) => n + t.reads, 0) / total) * 100);
  if (share < 60) return [];

  /* A sequential scan on a hot table is the finding inside the finding:
     it is the difference between busy and expensive. */
  const scanning = top.filter((t) => t.seqScans > t.idxScans);

  return [
    {
      id: "legacy_read_concentration",
      generator: "legacy_read_concentration",
      severity: scanning.length > 0 ? "high" : "medium",
      signalStrength: Math.min(100, share),
      title: `${share}% of all reads in ${legacyDatabaseName()} hit ${top.length} tables`,
      detail:
        `${top.map((t) => t.table).join(", ")} carry ${share}% of every read across ` +
        `${withReads.length} active tables` +
        (scanning.length
          ? `, and ${scanning.map((t) => t.table).join(" and ")} are being read mostly by ` +
            `sequential scan rather than by index — the expensive way to be popular.`
          : `. Anything that touches those three is worth caching first.`),
      action: { label: "Start any migration here", chip: "cross-source insights" },
      sources: ["legacy-database"],
    },
  ];
}

/* ── The same statement, over and over, from anywhere ─────────────── */

/**
 * The counterpart to redundant_source_reads, and the more honest one.
 *
 * That generator sees the requests WE issue, so on the first day it
 * sees nothing. This one reads the database's own statement counters,
 * so it covers every application connected to it — including the ones
 * we will never be plugged into. If a nightly job asks the same
 * question four hundred thousand times, this is the only place in the
 * product that can say so.
 */
export async function generateRepeatedQueryShapes(
  _ctx: InsightContext,
): Promise<CrossToolInsight[]> {
  const s = await scan();
  if (!s) return [];
  if (!s.statementStatsAvailable) {
    /* Reported as a gap, not omitted. "We could not look" is a
       different sentence from "there is nothing there", and only the
       first one is true. */
    return [
      {
        id: "legacy_statement_stats_unavailable",
        generator: "repeated_query_shapes",
        severity: "low",
        signalStrength: 20,
        title: `Statement-level load in ${legacyDatabaseName()} is not visible yet`,
        detail:
          `pg_stat_statements is not installed, so we can report which tables are busy ` +
          `but not which statements are causing it. Enabling it is a one-line change and ` +
          `turns the repeated-query analysis on for every application on that database, ` +
          `not only the ones connected to us.`,
        action: { label: "Enable pg_stat_statements", chip: "cross-source insights" },
        sources: ["legacy-database"],
      },
    ];
  }

  const hot = s.shapes
    .filter((q) => q.calls >= REPEAT_CALL_THRESHOLD)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 3);
  if (hot.length === 0) return [];

  return hot.map((q, i) => {
    const perCall = q.calls > 0 ? q.totalMs / q.calls : 0;
    const seconds = Math.round(q.totalMs / 1000);
    return {
      id: `repeated_query_shapes:${i}`,
      generator: "repeated_query_shapes",
      /* Cheap per call and enormous in aggregate is the classic shape
         of something in a loop that should have been one query. */
      severity: seconds >= 3600 ? "high" : seconds >= 300 ? "medium" : "low",
      signalStrength: Math.min(100, Math.round(seconds / 60)),
      title: `One statement has cost ${legacyDatabaseName()} ${seconds.toLocaleString()}s across ${q.calls.toLocaleString()} calls`,
      detail:
        `${q.shape} — averaging ${perCall.toFixed(1)}ms each. ` +
        (perCall < 5
          ? `Individually trivial, which is why nobody has noticed it; the cost is entirely ` +
            `in how many times it is asked.`
          : `Worth reading alongside which application issues it.`),
      action: { label: "Trace what issues this", chip: "cross-source insights" },
      sources: ["legacy-database"],
    } satisfies CrossToolInsight;
  });
}
