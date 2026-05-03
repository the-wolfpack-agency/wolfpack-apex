/**
 * porsche-classes / parser-xlsx — Porsche daily training-report parser.
 *
 * Source: a daily PCNA Training Report attachment exported from
 * Cornerstone. Sheet 1, header row near index 6, then one row per
 * (class, participant) pair. We filter to BA101 / BA102 (Brand
 * Ambassador 101 Skills / 102 Management) — those are the only
 * classes the program team tracks.
 *
 * Output: one `SnapshotInput` per distinct (course, date, location)
 * tuple. Participants per snapshot are deduped + canonicalized via
 * `normalize.ts`, so the delta engine sees a stable shape.
 *
 * Header tolerance — the parser used to assert exact column-by-index
 * header text and crashed with an unhelpful "expected X got Y" when
 * Cornerstone shipped a column-rename or a column-shuffle (which they
 * did on 2026-05-01). We now:
 *   * Search for the header row anywhere in the first 12 sheet rows
 *     (the historical layout has it at index 6; new exports occasionally
 *     prepend a logo/date row).
 *   * Match each canonical column by NAME using a synonyms map
 *     (case-insensitive, whitespace-tolerant), not by absolute column
 *     index. Empty cells in a header row are tolerated.
 *   * When a required column is missing, name the SPECIFIC missing
 *     canonical column(s) instead of "expected X got Y".
 *   * When a known-optional column (e.g. PPN ID, Facilities-fallback
 *     location) is missing, ingest with that field null instead of
 *     quarantining — only required columns are hard failures.
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
/* Header column synonyms                                              */
/*                                                                     */
/* Each canonical column lists the header strings that have appeared    */
/* in real prod exports. Match is case-insensitive + whitespace-        */
/* normalized (collapsing multiple spaces, ignoring trim) so the        */
/* parser tolerates tiny formatting drift without an entry update.      */
/* ------------------------------------------------------------------ */

/** Canonical column names used internally — these are the keys downstream
 *  code (per-row reads, error reporting) refers to. */
type CanonicalColumn =
  | "module_title"
  | "last_name"
  | "first_name"
  | "email"
  | "user_id"
  | "training_center"
  | "facilities"
  | "start_date";

/**
 * Synonyms map. Order matters ONLY for documentation — the matcher is
 * order-independent. New synonyms should be added at the END of each
 * list. Top entries are the historically-most-common shape.
 *
 * Top 3 entries per column (the user-facing examples in the report):
 *   module_title : "Module Properties-Module Title", "Module Title",
 *                  "Module Properties - Module Title"
 *   last_name    : "User Properties-Last Name", "Last Name",
 *                  "User Properties - Last Name"
 *   start_date   : "Session Properties-Start Date", "Start Date",
 *                  "Session Properties - Start Date"
 */
const SYNONYMS: Record<CanonicalColumn, string[]> = {
  module_title: [
    "Module Properties-Module Title",
    "Module Title",
    "Module Properties - Module Title",
    "Module Properties Module Title",
  ],
  last_name: [
    "User Properties-Last Name",
    "Last Name",
    "User Properties - Last Name",
    "Surname",
  ],
  first_name: [
    "User Properties-First Name",
    "First Name",
    "User Properties - First Name",
    "Given Name",
  ],
  email: [
    "User Properties-Email Address",
    "Email Address",
    "Email",
    "User Properties - Email Address",
    "Primary Email",
  ],
  user_id: [
    "User Properties-User ID",
    "User ID",
    "User Properties - User ID",
    "PPN ID",
    "PPN",
  ],
  training_center: [
    "Training Center-Training Center Name",
    "Training Center Name",
    "Training Center - Training Center Name",
    "Training Center",
  ],
  facilities: [
    "Session Properties-Facilities",
    "Facilities",
    "Session Properties - Facilities",
    "Facility",
    "Location",
  ],
  start_date: [
    "Session Properties-Start Date",
    "Start Date",
    "Session Properties - Start Date",
    "Class Start Date",
    "Session Start",
  ],
};

/** Required columns — header detection MUST find each of these or the
 *  parser quarantines with a clear "missing canonical column N" error.
 *  Every CanonicalColumn NOT in this list is OPTIONAL — when missing,
 *  per-row reads return null and the row continues to ingest with the
 *  affected field unset (instead of failing the whole artifact). */
const REQUIRED_COLUMNS: CanonicalColumn[] = [
  "module_title",
  "last_name",
  "first_name",
  "user_id",
  "start_date",
];

/** Normalize a header cell for matching: trim, lowercase, collapse runs
 *  of whitespace to a single space, strip the dash-vs-en-dash variants. */
function normalizeHeaderCell(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .replace(/[–—]/g, "-") // en/em dash → hyphen
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Build a map from normalized synonym → canonical column. */
function buildSynonymIndex(): Map<string, CanonicalColumn> {
  const out = new Map<string, CanonicalColumn>();
  for (const [canonical, synonyms] of Object.entries(SYNONYMS)) {
    for (const s of synonyms) {
      out.set(normalizeHeaderCell(s), canonical as CanonicalColumn);
    }
  }
  return out;
}

const SYNONYM_INDEX = buildSynonymIndex();

/* ------------------------------------------------------------------ */
/* Header detection — find the row + map columns by name               */
/* ------------------------------------------------------------------ */

interface HeaderResolution {
  row_index: number;
  /** Map from canonical column name → 0-based column index in the sheet. */
  columns: Partial<Record<CanonicalColumn, number>>;
}

/** Search the first N rows for the one that matches the most canonical
 *  columns. Returns the best-scoring row whose REQUIRED columns are all
 *  present, or null when no row qualifies. Captures empty cells without
 *  failing the whole row — only required-column absence is fatal. */
export function resolveHeaders(rows: unknown[][]): HeaderResolution | null {
  const SCAN_LIMIT = Math.min(rows.length, 12);
  let best: HeaderResolution | null = null;
  let bestScore = -1;
  for (let r = 0; r < SCAN_LIMIT; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length === 0) continue;
    const columns: Partial<Record<CanonicalColumn, number>> = {};
    for (let c = 0; c < row.length; c++) {
      const norm = normalizeHeaderCell(row[c]);
      if (!norm) continue; // empty cells are tolerated
      const canonical = SYNONYM_INDEX.get(norm);
      if (!canonical) continue;
      // First-wins per canonical column — duplicates in the same row
      // (rare but possible if Cornerstone repeats a column) shouldn't
      // overwrite the earlier index.
      if (columns[canonical] === undefined) columns[canonical] = c;
    }
    const score = Object.keys(columns).length;
    // A row qualifies only if EVERY required column was found.
    const hasAllRequired = REQUIRED_COLUMNS.every(
      (col) => columns[col] !== undefined,
    );
    if (hasAllRequired && score > bestScore) {
      bestScore = score;
      best = { row_index: r, columns };
    }
  }
  return best;
}

/** Diagnostic: which required columns are missing from the best row we
 *  could find? When the parser can't resolve headers at all, we want to
 *  tell the operator the SPECIFIC columns to look for. */
function diagnoseMissingColumns(rows: unknown[][]): {
  missing_required: CanonicalColumn[];
  best_row_index: number | null;
  /** First 30 normalized header values across the candidate row, for
   *  the operator's eyes. */
  observed_headers: string[];
} {
  const SCAN_LIMIT = Math.min(rows.length, 12);
  let bestIdx: number | null = null;
  let bestScore = -1;
  let observed: string[] = [];
  let missing: CanonicalColumn[] = [...REQUIRED_COLUMNS];
  for (let r = 0; r < SCAN_LIMIT; r++) {
    const row = rows[r];
    if (!Array.isArray(row) || row.length === 0) continue;
    const found = new Set<CanonicalColumn>();
    const headers: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const norm = normalizeHeaderCell(row[c]);
      if (norm) headers.push(norm);
      const canonical = SYNONYM_INDEX.get(norm);
      if (canonical) found.add(canonical);
    }
    const score = found.size;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = r;
      observed = headers.slice(0, 30);
      missing = REQUIRED_COLUMNS.filter((c) => !found.has(c));
    }
  }
  return {
    missing_required: missing,
    best_row_index: bestIdx,
    observed_headers: observed,
  };
}

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

  if (rows.length === 0) {
    return {
      ok: false,
      source_type: "porsche_xlsx",
      error: "xlsx sheet is empty",
      exception_kind: "parse_failure",
    };
  }

  const headers = resolveHeaders(rows);
  if (!headers) {
    const diag = diagnoseMissingColumns(rows);
    const missingList = diag.missing_required
      .map((c) => SYNONYMS[c][0])
      .join(", ");
    return {
      ok: false,
      source_type: "porsche_xlsx",
      error:
        `xlsx header layout drift: missing required column(s) [${missingList}]; ` +
        `parser scanned the first ${Math.min(rows.length, 12)} rows and could not find a header row containing every required column. ` +
        `Add the missing column name(s) to the SYNONYMS map in parser-xlsx.ts if Cornerstone renamed them.`,
      exception_kind: "parse_failure",
      detail: {
        missing_required_columns: diag.missing_required,
        best_candidate_row_index: diag.best_row_index,
        observed_headers: diag.observed_headers,
      },
    };
  }

  const headerRowIndex = headers.row_index;
  const COL = headers.columns;

  // Group by class_key components; each entry collects participant
  // strings (we let normalizeClass handle dedup + sort at the end).
  //
  // We ALSO collect a parallel `participants_with_ppn` list so the
  // snapshot payload can later answer "which PPN IDs are on the roster
  // for this class?" — used by the survey auto-splitter when a single
  // survey export covers multiple classes. Kept separate from the
  // existing `participants: string[]` so the delta engine's hash input
  // doesn't change shape.
  type ParticipantWithPpn = {
    first: string;
    last: string;
    ppn_id: string | null;
  };
  type Group = {
    course_type: CourseType;
    class_date: string;
    location: string;
    participants: string[];
    participants_with_ppn: ParticipantWithPpn[];
  };
  const byKey = new Map<string, Group>();

  // Track skipped rows so the exception detail can carry useful context
  // when the parser succeeds overall but rejects individual rows for
  // missing required fields. We do NOT fail the whole artifact on a
  // missing per-row field; we only fail when there are zero usable rows.
  let skippedNoCourse = 0;
  let skippedNoDate = 0;
  let skippedNoLocation = 0;

  /** Read a cell by canonical column name. Returns null when the column
   *  wasn't present in the resolved header (i.e. an OPTIONAL_COLUMN that
   *  the source file omitted) — caller must guard. */
  const readCell = (row: unknown[], col: CanonicalColumn): unknown => {
    const idx = COL[col];
    if (idx === undefined) return null;
    return row[idx];
  };

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const courseType = detectCourseType(
      readCell(row, "module_title") as string | null,
    );
    if (!courseType) {
      // Not BA101 / BA102 — silently filter (this report has thousands of
      // unrelated rows). Not a skip we count — it's expected.
      continue;
    }

    const classDate = parseReportDate(readCell(row, "start_date"));
    if (!classDate) {
      skippedNoDate += 1;
      continue;
    }

    // Location resolution: prefer the canonical Training Center column;
    // fall back to Facilities; finally null. When BOTH optional columns
    // were absent at the header layer, we still try by-name reads (read-
    // Cell returns null for an absent column, which falls through here).
    const trainingCenter = readCell(row, "training_center") as string | null;
    const facilities = readCell(row, "facilities") as string | null;
    const location = (trainingCenter ?? facilities ?? "")
      .toString()
      .trim();
    if (!location) {
      skippedNoLocation += 1;
      continue;
    }

    const lastName = (readCell(row, "last_name") ?? "").toString().trim();
    const firstName = (readCell(row, "first_name") ?? "").toString().trim();
    if (!lastName && !firstName) {
      skippedNoCourse += 1;
      continue;
    }
    const fullName = `${firstName} ${lastName}`.trim();
    // PPN ID may be missing on a small number of rows (test users,
    // etc.) — we keep them in the roster anyway, but with a null PPN
    // ID so the survey-splitter's name-vs-PPN coverage report can flag
    // them. The xlsx column is empty/whitespace in those cases.
    const rawPpn = (readCell(row, "user_id") ?? "").toString().trim();
    const ppn_id = rawPpn ? rawPpn.toLowerCase() : null;

    const key = `${courseType}|${classDate}|${location}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        course_type: courseType,
        class_date: classDate,
        location,
        participants: [],
        participants_with_ppn: [],
      };
      byKey.set(key, group);
    }
    group.participants.push(fullName);
    group.participants_with_ppn.push({
      first: firstName,
      last: lastName,
      ppn_id,
    });
  }

  if (byKey.size === 0) {
    return {
      ok: false,
      source_type: "porsche_xlsx",
      error: "no BA101 / BA102 rows found in xlsx",
      exception_kind: "missing_field",
      detail: {
        total_rows: rows.length - (headerRowIndex + 1),
        skipped_no_date: skippedNoDate,
        skipped_no_location: skippedNoLocation,
        skipped_no_name: skippedNoCourse,
      },
    };
  }

  const snapshots: SnapshotInput[] = [];
  for (const group of byKey.values()) {
    const cls = normalizeClass(group);
    // Dedupe roster entries by PPN ID (or full-name fallback when PPN
    // is null). Cornerstone occasionally emits the same user twice for
    // the same class — typically a transcript re-row when status
    // changes. Carrying duplicates through to source_payload would
    // break the survey-splitter's "this PPN is on this class" check by
    // inflating roster counts; dedupe here keeps the join key 1:1.
    const seen = new Set<string>();
    const dedupedWithPpn: ParticipantWithPpn[] = [];
    for (const p of group.participants_with_ppn) {
      const dedupeKey = p.ppn_id ?? `${p.first}|${p.last}`.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      dedupedWithPpn.push(p);
    }
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
        // Roster join keys for downstream consumers (survey splitter).
        // Shape: Array<{first, last, ppn_id|null}>. NOT the same shape
        // as `class.participants` (which is the sorted-lowercase string
        // array the delta engine hashes) — see splitMixedSurvey docs.
        participants_with_ppn: dedupedWithPpn,
      },
    });
  }

  return {
    ok: true,
    source_type: "porsche_xlsx",
    snapshots,
  };
}
