/**
 * Destructive-migration detector for the gate. DROP TABLE / TRUNCATE / DROP
 * COLUMN are VALID SQL that passes lint+tsc+tests+CI, so without this an
 * AI-authored data-loss migration reaches a human to merge with NO gate warning.
 * This flags it so the gate HOLDS it (critical -> needs_human): it does not
 * forbid a legitimate destructive migration, it forces a human to confirm the
 * irreversible op is intended + reversible - the blast-radius control.
 *
 * Precision-first:
 *  - DOWN migrations (*.down.sql) are EXPECTED to be destructive (their job is to
 *    undo), so they are skipped - flagging them would be pure false-positive.
 *  - Only UNAMBIGUOUS DDL (DROP TABLE/SCHEMA/DATABASE, TRUNCATE, DROP COLUMN).
 *    NOT DELETE/UPDATE: those legitimately run with a WHERE and in test cleanup,
 *    and a line-based "no WHERE" check is too noisy.
 *  - SQL comment lines (-- , /* , *) are skipped.
 */
import type { ScanFinding } from "@/lib/platform-scan/types";

const RULES: { re: RegExp; severity: "critical" | "high"; title: string; detail: string }[] = [
  {
    re: /\bdrop\s+(table|schema|database)\b/i,
    severity: "critical",
    title: "Destructive migration: DROP TABLE/SCHEMA/DATABASE",
    detail: "An AI-authored up-migration drops a table/schema/database - irreversible data loss. A human must confirm this is intended and that a rollback exists before it merges.",
  },
  {
    re: /\btruncate\b/i,
    severity: "critical",
    title: "Destructive migration: TRUNCATE",
    detail: "An AI-authored up-migration truncates a table - irreversible data loss. A human must confirm intent.",
  },
  {
    re: /\bdrop\s+column\b/i,
    severity: "high",
    title: "Destructive migration: DROP COLUMN",
    detail: "An AI-authored up-migration drops a column. The repo convention (.ai/conventions.md) requires a paired follow-up migration green in CI for a week before a DROP COLUMN. A human must confirm.",
  },
];

const isDownMigration = (path: string): boolean => /\.down\.sql$/i.test(path);
const isCommentLine = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("--") || t.startsWith("/*") || t.startsWith("*") || t === "";
};

/** Scan authored file contents for destructive DDL. Pure. */
export function scanDestructiveSql(files: Record<string, string>): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const [path, content] of Object.entries(files)) {
    if (isDownMigration(path)) continue; // destructive is the down-migration's JOB
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      for (const r of RULES) {
        if (r.re.test(line)) {
          out.push({
            route: `${path}:${i + 1}`,
            severity: r.severity,
            category: "security",
            title: r.title,
            detail: r.detail,
            evidence: { path, line: i + 1, statement: line.trim().slice(0, 120) },
          });
          break; // one finding per line
        }
      }
    }
  }
  return out;
}
