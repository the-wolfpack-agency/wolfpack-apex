/**
 * porsche-classes / parser-xlsx — Porsche daily training-report parser.
 *
 * Source: a daily PCNA Training Report attachment exported from
 * Cornerstone. Sheet 1, header row at index 6, then one row per
 * (class, participant) pair. We filter to BA101 / BA102 (Brand
 * Ambassador 101 Skills / 102 Management) — those are the only
 * classes the program team tracks.
 *
 * Output: one `SnapshotInput` per distinct (course, date, location)
 * tuple. Participants per snapshot are deduped + canonicalized via
 * `normalize.ts`, so the delta engine sees a stable shape.
 *
 * On parse failure we DO NOT throw — we return `ParseFailure` with a
 * structured `exception_kind`, and the orchestrator persists an
 * exception row + sets the artifact to `error_quarantined`. Per
 * memory feedback_no_silent_data_loss, every failure must materialize.
 */

import * as XLSX from "xlsx";
import type {
  ParseInput,
  ParseResult,
  SnapshotInput,
  CourseType,
} from "@/lib/automations/types";
import { normalizeClass } from "./normalize";

/* ------------------------------------------------------------------ */
/* Column layout — derived from porsche-daily-2026-04-20.xlsx fixture  */
/* ------------------------------------------------------------------ */

// Header row index (0-based) — row 6 is "Module Properties-Learning Type
// | Module Properties-Module ID | …". Verified against the real fixture.
const HEADER_ROW_INDEX = 6;

// Column indices (header verified against fixture). Future-proofed by
// also matching by header text if the layout changes.
const COL = {
  MODULE_TITLE: 2, // "Brand Ambassador 101 Skills (Classroom)"
  LAST_NAME: 4,
  FIRST_NAME: 5,
  EMAIL: 7,
  TRAINING_CENTER: 18, // primary location; fallback to FACILITIES (19)
  FACILITIES: 19,
  START_DATE: 21, // "Apr 13, 2026 6:00 PM"
} as const;

const EXPECTED_HEADERS: Record<number, string> = {
  [COL.MODULE_TITLE]: "Module Properties-Module Title",
  [COL.LAST_NAME]: "User Properties-Last Name",
  [COL.FIRST_NAME]: "User Properties-First Name",
  [COL.TRAINING_CENTER]: "Training Center-Training Center Name",
  [COL.START_DATE]: "Session Properties-Start Date",
};

/* ------------------------------------------------------------------ */
/* Course-type detection                                               */
/* ------------------------------------------------------------------ */

function detectCourseType(title: string | null | undefined): CourseType | null {
  if (!title) return null;
  const t = String(title);
  if (/Brand Ambassador 101/i.test(t)) return "BA101";
  if (/Brand Ambassador 102/i.test(t)) return "BA102";
  return null;
}

/* ------------------------------------------------------------------ */
/* Date parsing                                                        */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Parse the report's date format into ISO `YYYY-MM-DD`.
 *
 * Cornerstone exports dates as `Mmm DD, YYYY HH:MM AM/PM` text. We
 * deliberately skip `Date.parse()` for the primary path because the
 * timezone behavior of the host runtime can shift the day across the
 * date boundary — we want the LITERAL day from the report, not whatever
 * the JVM-local UTC offset produces.
 *
 * Returns null when the input is unrecognizable, so the caller can mark
 * an exception instead of pretending to know the date.
 */
export function parseReportDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // xlsx may return a Date object (when cellDates is set) or the
  // numeric serial (when not). We default to text via sheet_to_json's
  // raw=false; both forms are handled here for safety.
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (s.length === 0) return null;
  // "Apr 13, 2026 6:00 PM" — month name, day, year.
  const m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})/);
  if (m) {
    const mm = MONTHS[m[1].toLowerCase()];
    if (!mm) return null;
    const dd = m[2].padStart(2, "0");
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  // Already ISO?
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Header validation                                                   */
/* ------------------------------------------------------------------ */

function validateHeaders(row: unknown[]): string | null {
  for (const [idxStr, expected] of Object.entries(EXPECTED_HEADERS)) {
    const idx = Number(idxStr);
    const actual = String(row[idx] ?? "").trim();
    if (actual !== expected) {
      return `header column ${idx} expected "${expected}", got "${actual}"`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Public parser                                                       */
/* ------------------------------------------------------------------ */

export async function parseXlsx(input: ParseInput): Promise<ParseResult> {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(input.bytes, { type: "buffer", cellDates: false });
  } catch (err) {
    return {
      ok: false,
      source_type: "porsche_xlsx",
      error: `xlsx parse failed: ${(err as Error).message}`,
      exception_kind: "parse_failure",
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      ok: false,
      source_type: "porsche_xlsx",
      error: "workbook has no sheets",
      exception_kind: "parse_failure",
    };
  }
  const sheet = workbook.Sheets[sheetName];
  // header: 1 → array-of-arrays (we want positional access)
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });

  if (rows.length <= HEADER_ROW_INDEX) {
    return {
      ok: false,
      source_type: "porsche_xlsx",
      error: `sheet has ${rows.length} rows, expected at least ${HEADER_ROW_INDEX + 1}`,
      exception_kind: "parse_failure",
    };
  }

  const headerErr = validateHeaders(rows[HEADER_ROW_INDEX]);
  if (headerErr) {
    return {
      ok: false,
      source_type: "porsche_xlsx",
      error: `xlsx header layout drift: ${headerErr}`,
      exception_kind: "parse_failure",
      detail: { header_row: rows[HEADER_ROW_INDEX] },
    };
  }

  // Group by class_key components; each entry collects participant
  // strings (we let normalizeClass handle dedup + sort at the end).
  type Group = {
    course_type: CourseType;
    class_date: string;
    location: string;
    participants: string[];
  };
  const byKey = new Map<string, Group>();

  // Track skipped rows so the exception detail can carry useful context
  // when the parser succeeds overall but rejects individual rows for
  // missing required fields. We do NOT fail the whole artifact on a
  // missing per-row field; we only fail when there are zero usable rows.
  let skippedNoCourse = 0;
  let skippedNoDate = 0;
  let skippedNoLocation = 0;

  for (let r = HEADER_ROW_INDEX + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const courseType = detectCourseType(row[COL.MODULE_TITLE] as string | null);
    if (!courseType) {
      // Not BA101 / BA102 — silently filter (this report has thousands of
      // unrelated rows). Not a skip we count — it's expected.
      continue;
    }

    const classDate = parseReportDate(row[COL.START_DATE]);
    if (!classDate) {
      skippedNoDate += 1;
      continue;
    }

    const trainingCenter = row[COL.TRAINING_CENTER] as string | null;
    const facilities = row[COL.FACILITIES] as string | null;
    const location = (trainingCenter ?? facilities ?? "").toString().trim();
    if (!location) {
      skippedNoLocation += 1;
      continue;
    }

    const lastName = (row[COL.LAST_NAME] ?? "").toString().trim();
    const firstName = (row[COL.FIRST_NAME] ?? "").toString().trim();
    if (!lastName && !firstName) {
      skippedNoCourse += 1;
      continue;
    }
    const fullName = `${firstName} ${lastName}`.trim();

    const key = `${courseType}|${classDate}|${location}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        course_type: courseType,
        class_date: classDate,
        location,
        participants: [],
      };
      byKey.set(key, group);
    }
    group.participants.push(fullName);
  }

  if (byKey.size === 0) {
    return {
      ok: false,
      source_type: "porsche_xlsx",
      error: "no BA101 / BA102 rows found in xlsx",
      exception_kind: "missing_field",
      detail: {
        total_rows: rows.length - (HEADER_ROW_INDEX + 1),
        skipped_no_date: skippedNoDate,
        skipped_no_location: skippedNoLocation,
        skipped_no_name: skippedNoCourse,
      },
    };
  }

  const snapshots: SnapshotInput[] = [];
  for (const group of byKey.values()) {
    const cls = normalizeClass(group);
    snapshots.push({
      source_type: "porsche_xlsx",
      source_message_id: input.source_message_id,
      source_artifact_id: input.source_artifact_id,
      captured_at: input.received_at,
      class: cls,
      source_payload: {
        skipped_no_date: skippedNoDate,
        skipped_no_location: skippedNoLocation,
        skipped_no_name: skippedNoCourse,
      },
    });
  }

  return {
    ok: true,
    source_type: "porsche_xlsx",
    snapshots,
  };
}
