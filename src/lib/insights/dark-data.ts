/**
 * What is in there that nobody has ever asked for.
 *
 * A database that has been running for a decade holds two kinds of
 * thing: the columns the applications read, and the columns somebody
 * added because the data was there and the tooling of the day could not
 * do anything with it. Nobody in the building can tell you which is
 * which, because answering it means diffing the schema against every
 * statement the system has ever run, and no one has ever had both
 * halves in one place.
 *
 * We do. #340 already reads the statement shapes and the table
 * catalog. This subtracts one from the other.
 *
 * THE DIRECTION THIS IS ALLOWED TO BE WRONG IN
 *
 * Telling a client a column is unused when something reads it is
 * unrecoverable: they check one, find it wrong, and correctly stop
 * believing the rest. Missing a genuinely dark column costs nothing,
 * because they never knew about it anyway.
 *
 * So every rule here is biased towards silence:
 *
 *   - A column counts as USED if its name appears as a whole word
 *     anywhere in any statement, even in a statement against a
 *     different table. Cheap to over-count usage, expensive to invent
 *     a dark column.
 *   - A table queried with SELECT * is excluded entirely, along with
 *     every column in it. Star-select means the statement text cannot
 *     tell us which columns were read, so nothing about that table is
 *     knowable this way and we say so instead of guessing.
 *   - A column whose table has never been analyzed is excluded. No
 *     sample means no evidence it holds anything, and "there is data
 *     in here nobody reads" requires knowing there is data in it.
 *   - Structural columns are excluded. A primary key nobody names
 *     explicitly is not a discovery.
 */

import type { LegacyScan } from "@/lib/sources/legacy-postgres";

/** Above this fraction of nulls, the column is effectively empty. */
export const MOSTLY_NULL = 0.95;

/**
 * Names that mean nothing on their own. A dark `id` or `created_at` is
 * not an insight, it is noise that buries the real finding.
 */
const STRUCTURAL = new Set([
  "id",
  "uuid",
  "guid",
  "created_at",
  "updated_at",
  "deleted_at",
  "created",
  "modified",
  "timestamp",
  "version",
  "etag",
  "rowversion",
]);

/**
 * A name too short or too common to match on safely.
 *
 * "no" or "type" would appear inside some statement somewhere by pure
 * chance, which pushes them towards being called used, and that is the
 * safe direction. The reason to skip them is the opposite risk: a
 * three-letter column that genuinely never appears is far more likely
 * to be a matching artefact than a discovery.
 */
function tooAmbiguousToJudge(column: string): boolean {
  return column.length < 4;
}

export interface DarkColumn {
  table: string;
  column: string;
  dataType: string;
  /** Share of rows holding a value, from the planner's sample. */
  populated: number;
}

export interface DarkDataReport {
  /** Columns with data that no statement has ever named. */
  dark: DarkColumn[];
  /** Tables excluded because a SELECT * makes their columns unknowable. */
  starSelectTables: string[];
  /** Columns skipped because their table has never been analyzed. */
  unanalyzed: number;
  /** How many statements the conclusion is drawn from. */
  statementsExamined: number;
}

/** Whole-word presence, case-insensitive, across the whole corpus. */
function mentioned(corpus: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i").test(corpus);
}

/**
 * Tables whose statements use SELECT *, so column-level usage cannot be
 * read out of the statement text at all.
 *
 * Matched by looking for the table name after FROM or JOIN in any
 * statement that selects a star. Deliberately broad: a table caught
 * here is simply excluded, and excluding a table we could have analyzed
 * costs a finding we never claimed.
 */
export function starSelectTables(shapes: string[], tables: string[]): Set<string> {
  const out = new Set<string>();
  for (const shape of shapes) {
    if (!/select\s+\*/i.test(shape)) continue;
    for (const t of tables) {
      if (new RegExp(`(from|join)\\s+[a-z0-9_."]*\\b${t}\\b`, "i").test(shape)) out.add(t);
    }
  }
  return out;
}

export function findDarkData(scan: LegacyScan): DarkDataReport {
  /* With no statement history there is nothing to subtract, and every
     populated column in the database would be reported as unread. The
     renderer said the right thing about this case and the REPORT did
     not, so anything reading .dark directly (a widget, a count in
     analytics, a future caller) got a list of every column in the
     database presented as a discovery. Found by running against a real
     server that did not have pg_stat_statements installed. */
  if (scan.shapes.length === 0) {
    return {
      dark: [],
      starSelectTables: [],
      unanalyzed: 0,
      statementsExamined: 0,
    };
  }

  const tableNames = [...new Set(scan.columns.map((c) => c.table))];
  const shapeTexts = scan.shapes.map((s) => s.shape);
  const corpus = shapeTexts.join("\n");
  const starred = starSelectTables(shapeTexts, tableNames);

  let unanalyzed = 0;
  const dark: DarkColumn[] = [];

  for (const col of scan.columns) {
    if (starred.has(col.table)) continue;
    if (STRUCTURAL.has(col.column.toLowerCase())) continue;
    if (tooAmbiguousToJudge(col.column)) continue;
    if (col.nullFraction === null) {
      unanalyzed++;
      continue;
    }
    if (col.nullFraction >= MOSTLY_NULL) continue;
    if (mentioned(corpus, col.column)) continue;

    dark.push({
      table: col.table,
      column: col.column,
      dataType: col.dataType,
      populated: Math.round((1 - col.nullFraction) * 100) / 100,
    });
  }

  dark.sort((a, b) => b.populated - a.populated || a.table.localeCompare(b.table));

  return {
    dark,
    starSelectTables: [...starred].sort(),
    unanalyzed,
    statementsExamined: scan.shapes.length,
  };
}

/**
 * How to say it without overclaiming.
 *
 * The framing is "no statement we can see names this", never "this is
 * unused". The distinction is the difference between a finding a DBA
 * investigates and one they dismiss, and the second version is also not
 * true: a statement outside the sample window would not be here.
 */
export function renderDarkData(report: DarkDataReport, dbName: string): string {
  if (report.statementsExamined === 0) {
    return (
      `No statement history is available for ${dbName}, so there is nothing to compare ` +
      `the schema against. With pg_stat_statements enabled this becomes a one-line check.`
    );
  }
  if (report.dark.length === 0) {
    const caveat = report.starSelectTables.length
      ? ` ${report.starSelectTables.length} tables are read with SELECT *, so their columns ` +
        `cannot be judged this way.`
      : "";
    return `Every populated column in ${dbName} is named by at least one statement.${caveat}`;
  }

  const byTable = new Map<string, DarkColumn[]>();
  for (const c of report.dark) {
    byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
  }

  const lines: string[] = [
    `**${report.dark.length} populated columns in ${dbName} are not named by any of the ` +
      `${report.statementsExamined} statements on record.**`,
    "",
    `Something put data in them and nothing reads it back. In a system of this age that is ` +
      `usually a field added when the reporting tools of the day could not do anything with ` +
      `it, and then left running.`,
    "",
  ];

  for (const [table, cols] of [...byTable.entries()].slice(0, 8)) {
    const detail = cols
      .slice(0, 6)
      .map((c) => `${c.column} (${c.dataType}, ${Math.round(c.populated * 100)}% filled)`)
      .join(", ");
    lines.push(`- \`${table}\`: ${detail}`);
  }

  lines.push(
    "",
    `Read this as "no statement we can see names these", not "these are unused": a query ` +
      `that ran before the statistics window would not appear here.`,
  );

  if (report.starSelectTables.length > 0) {
    lines.push(
      "",
      `${report.starSelectTables.length} ${report.starSelectTables.length === 1 ? "table is" : "tables are"} ` +
        `read with SELECT *, so nothing about column usage there is knowable from statement ` +
        `text and it is excluded entirely.`,
    );
  }
  if (report.unanalyzed > 0) {
    lines.push(
      "",
      `${report.unanalyzed} columns sit in tables the planner has never sampled, so whether ` +
        `they hold anything is unknown and they are excluded too.`,
    );
  }

  return lines.join("\n");
}
