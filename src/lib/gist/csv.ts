/**
 * A CSV reader that survives a real export.
 *
 * WHY NOT THE ONE THAT EXISTS. brain/extractor.ts splits on commas and says so
 * in its own comment: "a tolerant naive split... every major spreadsheet app
 * exports CSV without embedded commas for the header row". That is true of
 * headers and false of everything under them. A change-request export is full
 * of quoted descriptions with commas and newlines in them, and a naive split
 * would shift every column after the first quoted field.
 *
 * The consequence is worse than a crash. Columns would silently misalign, a
 * status column would fill with fragments of somebody's description, and the
 * analysis would come out confident and wrong. That is the failure mode this
 * codebase has spent the week removing.
 *
 * WHY NOT A DEPENDENCY. The engineering directive asks for justification
 * before a new runtime dependency, and RFC 4180 is thirty lines: quoted
 * fields, doubled quotes as an escape, and newlines inside quotes. Small,
 * closed, and testable against the cases that actually break naive parsers.
 */

export interface CsvTable {
  headers: string[];
  /** Rows keyed by header. Short rows are padded so a lookup never throws. */
  rows: Array<Record<string, string>>;
}

/**
 * Split CSV text into fields, honouring quotes.
 *
 * Returns rows of raw cells. The caller decides what a header is, because a
 * spreadsheet export sometimes carries a title line above it.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  /* Byte order marks arrive on most Windows exports and would otherwise
     become part of the first header's name, so the column would never match. */
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        /* A doubled quote is an escaped quote, not the end of the field. */
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }

  /* A file that does not end in a newline still has a last row. */
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

/**
 * Read a table, treating the first non-empty row as the header.
 *
 * Rows with fewer cells than headers are padded rather than dropped: a short
 * row usually means trailing empty columns, and dropping it would quietly
 * shrink the data set somebody is about to draw conclusions from.
 */
export function parseCsv(text: string): CsvTable {
  const raw = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = raw[0].map((h) => h.trim());
  const rows = raw.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = (cells[i] ?? "").trim();
    });
    return record;
  });
  return { headers, rows };
}
