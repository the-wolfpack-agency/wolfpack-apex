/**
 * Porsche Academy class survey parser — REAL impl.
 *
 * Source: an xlsx export Alicia receives Friday afternoons / Monday
 * mornings titled like "Survey Data PCBA 101 Pendry March 23-27th.xlsx".
 * Single sheet, long-format rows where each row is one
 * (respondent, question, response) tuple.
 *
 * Header row (verified across three real fixtures):
 *   Assessment Name | First Name | Last Name | Status | PPN ID | Role |
 *   Submission Time | Question Type | Prompt | Response
 *
 * Question Type vocabulary:
 *   - SINGLE_ANSWER → Likert-style; Response is one of
 *     {Strongly disagree, Disagree, Agree, Strongly agree}
 *     (case + spacing tolerated; "Strong Disagree" also seen).
 *   - OPEN_ANSWER   → free text; collected as comments.
 *
 * Class identity is NOT in the data — it lives in the filename. We
 * extract `course | class_date | location` from `input.hint` and refuse
 * to ingest if the filename names two courses (e.g. "101 Intercontinental
 * & 102 Conrad" — Alicia splits these manually today; until we have a
 * roster lookup, surface a clear `parse_failure` instead of bucketing
 * mixed responses into one class).
 *
 * On success: emits ONE SnapshotInput with `source_payload.survey`
 * holding the SurveyAggregate the summary renderer expects.
 */

import * as XLSX from "xlsx";
import type {
  ParseInput,
  ParseResult,
  Parser,
  CourseType,
  SnapshotInput,
  SurveyAggregate,
} from "../types";
import {
  buildClassKey as _buildClassKey,
  normalizeLocation,
} from "./normalize";
import { normalizeClassDate } from "./cognito-html";

const SOURCE_TYPE = "survey" as const;

/* ------------------------------------------------------------------ */
/* Likert mapping                                                      */
/* ------------------------------------------------------------------ */

/**
 * 4-point forced-choice Likert mapped to a 5-point average so the
 * "Average 1-5 score" contract on `SurveyAggregate` lines up. The two
 * "agree" buckets sit at 4 and 5; the two "disagree" buckets at 1 and 2.
 * No 3 (no neutral option in the survey instrument).
 *
 * Tolerant of capitalization + the "Strong Disagree" typo seen in one
 * real export.
 */
const LIKERT_TO_SCORE: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /^strongly\s*agree$/i, score: 5 },
  { pattern: /^strongly\s*disagree$/i, score: 1 },
  { pattern: /^strong\s*disagree$/i, score: 1 }, // typo seen in fixture
  { pattern: /^strong\s*agree$/i, score: 5 }, // symmetric typo guard
  { pattern: /^agree$/i, score: 4 },
  { pattern: /^disagree$/i, score: 2 },
];

function likertToScore(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  for (const m of LIKERT_TO_SCORE) {
    if (m.pattern.test(s)) return m.score;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Filename → class identity                                           */
/* ------------------------------------------------------------------ */

/* Match 101 or 102 surrounded by NON-DIGIT (or start/end). Plain \b
   doesn't work because underscore is a word character — "_101 " has
   no word-boundary between "_" and "1" — so we explicitly require a
   non-digit context. */
const COURSE_RE = /(?<![0-9])(101|102)(?![0-9])/g;
/* Long + short month names. Order matters — longer alternatives first
   so the regex engine doesn't match "apr" inside "april" and stop. */
const ANY_MONTH =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)";
const MONTH_NUM: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08", sep: "09", sept: "09",
  oct: "10", nov: "11", dec: "12",
};

interface ClassIdentityHit {
  course_type: CourseType;
  class_date: string; // YYYY-MM-DD (start of range)
  location: string;
}

/**
 * Pull (course, date, location) out of the survey filename.
 *
 * Real-world examples:
 *   - "Survey Data PCBA 101 Pendry March 23-27th.xlsx"
 *     → BA101, 2026-03-23, Pendry
 *   - "Survey Data PCBA 101 Conrad & Westlake_April 13-17.xlsx"
 *     → BA101, 2026-04-13, "Conrad & Westlake" (one class at two hotels)
 *   - "102 Intercontinental March 16-20, 2026.xlsx"
 *     → BA102, 2026-03-16, Intercontinental
 *   - "Survey Data PCBA_April 6-10_101 Intercontinental & 102 Conrad.xlsx"
 *     → ambiguous — TWO courses named, refuse with helpful error
 *
 * Returns null on parse failure; caller surfaces `parse_failure`.
 */
export function parseClassIdentityFromFilename(
  filename: string,
  fallbackYear: number,
): ClassIdentityHit | { error: string } {
  const stem = filename.replace(/\.[^./\\]+$/, "");
  /* Detect ambiguous multi-course filenames before anything else. */
  const courseHits = stem.match(COURSE_RE) ?? [];
  const distinctCourses = Array.from(new Set(courseHits));
  if (distinctCourses.length > 1) {
    return {
      error:
        `Filename names multiple courses (${distinctCourses.join(", ")}); ` +
        `survey responses can't be split without a class roster. ` +
        `Save one file per class first.`,
    };
  }
  if (distinctCourses.length === 0) {
    return { error: `Filename has no recognizable course code (101/102): "${filename}"` };
  }
  const courseNum = distinctCourses[0];
  const course_type: CourseType = courseNum === "101" ? "BA101" : "BA102";

  /* Date: try "Month DD-DD[th]" then "Month DD-DD, YYYY" then "M/D/YYYY". */
  const dateRange = stem.match(
    new RegExp(`${ANY_MONTH}\\s+(\\d{1,2})\\s*[-–]\\s*\\d{1,2}(?:st|nd|rd|th)?(?:,\\s*(\\d{4}))?`, "i"),
  );
  let class_date: string | null = null;
  if (dateRange) {
    const month = MONTH_NUM[dateRange[1].toLowerCase()];
    const day = dateRange[2].padStart(2, "0");
    const year = dateRange[3] ?? String(fallbackYear);
    class_date = `${year}-${month}-${day}`;
  } else {
    /* M/D/YYYY fallback (rare). */
    const us = stem.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) class_date = normalizeClassDate(`${us[1]}/${us[2]}/${us[3]}`);
  }
  if (!class_date) {
    return { error: `Filename has no recognizable date range: "${filename}"` };
  }

  /* Location: everything that's neither the course token, the date
     range, nor the boilerplate "Survey Data PCBA". Take the longest
     human-y span we can find. */
  const cleaned = stem
    .replace(/^Survey Data\s*/i, "")
    .replace(/^PCBA\s*/i, "")
    .replace(/_/g, " ")
    .replace(/(?<![0-9])(101|102)(?![0-9])/g, " ")
    .replace(
      new RegExp(`${ANY_MONTH}\\s+\\d{1,2}\\s*[-–]\\s*\\d{1,2}(?:st|nd|rd|th)?(?:,\\s*\\d{4})?`, "ig"),
      " ",
    )
    .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const location = normalizeLocation(cleaned || "Unknown");

  return { course_type, class_date, location };
}

/* ------------------------------------------------------------------ */
/* Parse helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Two known PCNA export shapes — same data, different column headers.
 *
 * Legacy shape (used through ~April 10): "Assessment Name", "First Name",
 * "Last Name", "Status", "PPN ID", "Role", "Submission Time",
 * "Question Type", "Prompt", "Response".
 *
 * v2 shape (April 6-10 onward): "question_order", "question_text",
 * "question_type", "submitted_answer", "submitted_at_utc",
 * "submitted_at_et", "lmsId", "firstName", "lastName", "email". No
 * Status column — assume every row counts.
 *
 * `RawRow` is the legacy shape; v2 rows are normalized into this shape
 * by `normalizeRow()` so the rest of the parser is format-agnostic.
 */
export interface RawRow {
  "Assessment Name"?: string | null;
  "First Name"?: string | null;
  "Last Name"?: string | null;
  Status?: string | null;
  "PPN ID"?: string | null;
  Role?: string | null;
  "Submission Time"?: string | number | Date | null;
  "Question Type"?: string | null;
  Prompt?: string | null;
  Response?: string | null;
}

interface RawRowV2 {
  question_order?: number | string | null;
  question_text?: string | null;
  question_type?: string | null;
  submitted_answer?: string | null;
  submitted_at_utc?: string | null;
  submitted_at_et?: string | null;
  lmsId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

function isV2Shape(sample: Record<string, unknown>): boolean {
  return (
    "question_text" in sample &&
    "submitted_answer" in sample &&
    "question_type" in sample
  );
}

function normalizeRow(raw: Record<string, unknown>): RawRow {
  if (!isV2Shape(raw)) return raw as RawRow;
  const r = raw as RawRowV2;
  return {
    "Assessment Name": null,
    "First Name": r.firstName ?? null,
    "Last Name": r.lastName ?? null,
    Status: "ACTIVE", // v2 export has no Status column; treat all as active.
    "PPN ID": r.lmsId ?? null,
    Role: null,
    "Submission Time": r.submitted_at_utc ?? null,
    "Question Type": r.question_type ?? null,
    Prompt: r.question_text ?? null,
    Response: r.submitted_answer ?? null,
  };
}

function fail(error: string, detail?: Record<string, unknown>): ParseResult {
  return {
    ok: false,
    source_type: SOURCE_TYPE,
    error,
    exception_kind: "parse_failure",
    detail: detail ?? {},
  };
}

function missingHeader(error: string): ParseResult {
  return {
    ok: false,
    source_type: SOURCE_TYPE,
    error,
    exception_kind: "missing_field",
    detail: {},
  };
}

/* ------------------------------------------------------------------ */
/* Aggregator                                                          */
/* ------------------------------------------------------------------ */

interface PerPrompt {
  scores: number[];
  comments: string[];
}

function aggregate(rows: RawRow[]): SurveyAggregate {
  const respondents = new Set<string>();
  const byPrompt = new Map<string, PerPrompt>();

  for (const r of rows) {
    if (r["Status"] && String(r["Status"]).toUpperCase() !== "ACTIVE") {
      /* Skip dropped/inactive participants — they show up in the export
         but never finished the survey. */
      continue;
    }
    const prompt = (r["Prompt"] ?? "").trim();
    if (!prompt) continue;
    const respKey = `${r["First Name"] ?? ""}|${r["Last Name"] ?? ""}|${r["PPN ID"] ?? ""}`;
    respondents.add(respKey);

    const bucket = byPrompt.get(prompt) ?? { scores: [], comments: [] };
    const qType = String(r["Question Type"] ?? "").toUpperCase();
    if (qType === "SINGLE_ANSWER") {
      const score = likertToScore(r["Response"]);
      if (score !== null) bucket.scores.push(score);
    } else if (qType === "OPEN_ANSWER") {
      const txt = (r["Response"] ?? "").toString().trim();
      if (txt) bucket.comments.push(txt);
    }
    byPrompt.set(prompt, bucket);
  }

  const questions: SurveyAggregate["questions"] = [];
  const allScores: number[] = [];
  for (const [prompt, b] of byPrompt) {
    let avg: number | null = null;
    if (b.scores.length > 0) {
      avg = b.scores.reduce((a, c) => a + c, 0) / b.scores.length;
      for (const s of b.scores) allScores.push(s);
    }
    questions.push({ question: prompt, average: avg, comments: b.comments });
  }

  const average_score =
    allScores.length > 0
      ? allScores.reduce((a, c) => a + c, 0) / allScores.length
      : null;

  return {
    response_count: respondents.size,
    average_score,
    questions,
  };
}

/* ------------------------------------------------------------------ */
/* Raw byte decoder — reusable by the orchestrator's split path        */
/* ------------------------------------------------------------------ */

/**
 * Decode survey bytes to typed `RawRow[]`. Exposed so the ingest
 * orchestrator can call `splitMixedSurvey` against the same row shape
 * the parser uses without re-implementing the xlsx read logic.
 *
 * Returns `{ error }` on the same failure modes `parseSurvey` surfaces:
 * unreadable workbook, no sheets, empty sheet, missing required
 * columns. The orchestrator falls through to its existing quarantine
 * behavior in those cases.
 */
export function decodeSurveyRows(
  bytes: Buffer,
): { rows: RawRow[] } | { error: string } {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: "buffer" });
  } catch (err) {
    return { error: `Could not read survey workbook: ${(err as Error).message}` };
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { error: "Survey workbook has no sheets" };
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets[sheetName],
    { defval: null },
  );
  if (rawRows.length === 0) return { error: "Survey workbook is empty" };
  const sample = rawRows[0];
  const isLegacy =
    "Prompt" in sample &&
    "Question Type" in sample &&
    "Response" in sample;
  const isV2 = isV2Shape(sample);
  if (!isLegacy && !isV2) {
    return {
      error: `Survey workbook missing required columns. Got: ${Object.keys(sample).join(", ")}`,
    };
  }
  /* Normalize v2 rows into the legacy shape so the rest of the parser
     (aggregate, splitMixedSurvey, collectRespondents) is format-blind. */
  const rows = rawRows.map(normalizeRow);
  return { rows };
}

/* ------------------------------------------------------------------ */
/* Mixed-class filename parsing — for orchestrator candidate lookup    */
/* ------------------------------------------------------------------ */

/** Extract the (likely) course tokens + a date window from a multi-class
 *  survey filename. Returns null if the filename has no recognizable
 *  date range; otherwise returns the union of courses found and an
 *  inclusive `[start, end]` ISO-date pair (the splitter caller then
 *  widens this by ±tolerance days when querying candidate classes).
 *
 *  This is intentionally permissive — it's the input to a candidate
 *  lookup, not a hard rejection gate. Returning multiple courses is
 *  the EXPECTED case (this helper exists for the multi-course branch).
 */
export function parseMultiClassFilename(
  filename: string,
  fallbackYear: number,
): {
  course_types: CourseType[];
  date_start: string;
  date_end: string;
} | null {
  const stem = filename.replace(/\.[^./\\]+$/, "");
  const courseHits = stem.match(COURSE_RE) ?? [];
  const distinctCourses = Array.from(new Set(courseHits));
  if (distinctCourses.length === 0) return null;

  const courseTypes: CourseType[] = distinctCourses.map((c) =>
    c === "101" ? "BA101" : "BA102",
  );

  // Match "Month DD-DD[th][, YYYY]" — same shape as the single-class path.
  const dateRange = stem.match(
    new RegExp(
      `${ANY_MONTH}\\s+(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*(\\d{4}))?`,
      "i",
    ),
  );
  if (!dateRange) return null;
  const month = MONTH_NUM[dateRange[1].toLowerCase()];
  if (!month) return null;
  const dayStart = dateRange[2].padStart(2, "0");
  const dayEnd = dateRange[3].padStart(2, "0");
  const year = dateRange[4] ?? String(fallbackYear);
  return {
    course_types: courseTypes,
    date_start: `${year}-${month}-${dayStart}`,
    date_end: `${year}-${month}-${dayEnd}`,
  };
}

/* ------------------------------------------------------------------ */
/* Mixed-class auto-splitter                                           */
/* ------------------------------------------------------------------ */

/**
 * One candidate class the splitter is allowed to route respondents to.
 * `roster_ppns` is the set of PPN IDs the daily report says belong to
 * this class — that's the join key. Lowercased; the splitter
 * lowercases on its side too so callers can pass either case.
 */
export interface CandidateClass {
  course_type: CourseType;
  /** ISO date `YYYY-MM-DD`. */
  class_date: string;
  /** Already-normalized location (`normalizeLocation` output). */
  location: string;
  /** Set of PPN IDs that appear on this class's roster. */
  roster_ppns: Set<string>;
}

export interface SplitMixedSurveyArgs {
  rows: RawRow[];
  filename: string;
  receivedAt: string;
  sourceMessageId: string | null;
  sourceArtifactId: string;
  candidateClasses: CandidateClass[];
}

/**
 * Auto-split a mixed-class survey export.
 *
 * Today, when a single survey xlsx contains responses from multiple
 * classes (e.g. "Survey Data PCBA_April 6-10_101 Intercontinental &
 * 102 Conrad.xlsx"), the regular `parseSurvey` refuses with a
 * `parse_failure: multiple courses` because the file alone doesn't
 * say which respondent went to which class. Alicia handles this
 * manually today by cross-referencing the daily roster.
 *
 * `splitMixedSurvey` does that programmatically. The orchestrator
 * passes in the candidate classes (from `instinct_automation_porsche_snapshots`
 * `source_type='porsche_xlsx'` snapshots that match the courses + dates
 * in the filename, ±a few days), each with the PPN IDs from its
 * roster. We bucket each respondent by which roster their PPN ID
 * matches, then aggregate per-class and emit one snapshot per matched
 * class.
 *
 * Respondents whose PPN ID matches NO candidate roster (e.g. a
 * walk-in that wasn't in the daily report) are recorded under
 * `source_payload.unmatched_respondents` on the FIRST emitted
 * snapshot so they're never silently dropped.
 *
 * Returns `[]` when there are zero usable respondents OR zero
 * candidate classes — caller should fall through to quarantine in
 * that case so the artifact still surfaces in the exception queue.
 */
export function splitMixedSurvey(args: SplitMixedSurveyArgs): SnapshotInput[] {
  if (args.candidateClasses.length === 0) return [];
  if (args.rows.length === 0) return [];

  // Index candidates by their lowercased PPN IDs for O(1) lookup.
  // We DON'T require unique PPN-to-class mapping: if a PPN somehow
  // appears on two rosters (it shouldn't, but defensively) the first
  // candidate wins — deterministic on candidate input order.
  const ppnToClassIdx = new Map<string, number>();
  for (let i = 0; i < args.candidateClasses.length; i++) {
    for (const p of args.candidateClasses[i].roster_ppns) {
      const k = p.toLowerCase().trim();
      if (!k) continue;
      if (!ppnToClassIdx.has(k)) ppnToClassIdx.set(k, i);
    }
  }

  // Bucket survey rows by candidate-class index. Rows with PPN IDs
  // that match NO candidate go to the `unmatched` bucket so they
  // surface as a warning rather than a silent drop.
  const buckets: RawRow[][] = args.candidateClasses.map(() => []);
  const unmatchedRespondents = new Map<
    string,
    { first: string; last: string; ppn_id: string | null }
  >();

  for (const row of args.rows) {
    const ppnRaw = (row["PPN ID"] ?? "").toString().trim().toLowerCase();
    if (!ppnRaw) {
      // No PPN ID at all — track as unmatched so reviewers see the gap.
      const respKey = `${row["First Name"] ?? ""}|${row["Last Name"] ?? ""}|`;
      if (!unmatchedRespondents.has(respKey)) {
        unmatchedRespondents.set(respKey, {
          first: (row["First Name"] ?? "").toString(),
          last: (row["Last Name"] ?? "").toString(),
          ppn_id: null,
        });
      }
      continue;
    }
    const idx = ppnToClassIdx.get(ppnRaw);
    if (idx === undefined) {
      const respKey = `${row["First Name"] ?? ""}|${row["Last Name"] ?? ""}|${ppnRaw}`;
      if (!unmatchedRespondents.has(respKey)) {
        unmatchedRespondents.set(respKey, {
          first: (row["First Name"] ?? "").toString(),
          last: (row["Last Name"] ?? "").toString(),
          ppn_id: ppnRaw,
        });
      }
      continue;
    }
    buckets[idx].push(row);
  }

  // Build one snapshot per candidate class that actually got rows.
  // Empty buckets are skipped — emitting a 0-respondent snapshot for a
  // class that had no survey responses would create a misleading "0
  // average" rollup downstream. The class will simply have no survey
  // snapshot for this artifact, which is the correct semantics.
  const snapshots: SnapshotInput[] = [];
  const unmatchedList = Array.from(unmatchedRespondents.values());
  let unmatchedAttached = false;

  for (let i = 0; i < args.candidateClasses.length; i++) {
    const bucket = buckets[i];
    if (bucket.length === 0) continue;
    const cand = args.candidateClasses[i];
    const aggregate_value = aggregate(bucket);
    if (aggregate_value.response_count === 0) continue;

    const payload: Record<string, unknown> = {
      survey: aggregate_value,
      fixture_filename: args.filename,
      // Mark the snapshot as the product of an auto-split — useful
      // for the dashboard's "needs review" filter and for analytics
      // (we want to see how often the splitter is invoked vs. the
      // single-class happy path).
      auto_split_from_mixed_survey: true,
      auto_split_total_candidates: args.candidateClasses.length,
    };
    if (!unmatchedAttached && unmatchedList.length > 0) {
      // Attach the unmatched roster ONCE — the first snapshot we emit
      // — so downstream UI/analytics can surface it without having to
      // dedupe across snapshots.
      payload.unmatched_respondents = unmatchedList;
      unmatchedAttached = true;
    }

    snapshots.push({
      source_type: SOURCE_TYPE,
      source_message_id: args.sourceMessageId,
      source_artifact_id: args.sourceArtifactId,
      captured_at: args.receivedAt,
      class: {
        course_type: cand.course_type,
        class_date: cand.class_date,
        location: cand.location,
        participants: collectRespondents(bucket),
      },
      source_payload: payload,
    });
  }

  return snapshots;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export const parseSurvey: Parser = async (
  input: ParseInput,
): Promise<ParseResult> => {
  /* 1+2. Decode bytes + header sanity in one helper, so the
     orchestrator's split-path can reuse the exact same decode logic. */
  const decoded = decodeSurveyRows(input.bytes);
  if ("error" in decoded) {
    // Header-mismatch is a different exception_kind than a workbook
    // read failure — preserve that distinction for the exception queue.
    if (decoded.error.startsWith("Survey workbook missing required columns")) {
      return missingHeader(
        decoded.error.replace(
          "Got:",
          "Expected Prompt / Question Type / Response, got:",
        ),
      );
    }
    return fail(decoded.error, { hint: input.hint });
  }
  const rows = decoded.rows;

  /* 3. Class identity from filename. Multi-class files refuse here. */
  const fallbackYear = Number(input.received_at.slice(0, 4)) || new Date().getFullYear();
  const ident = parseClassIdentityFromFilename(input.hint, fallbackYear);
  if ("error" in ident) {
    return fail(ident.error, { hint: input.hint });
  }

  /* 4. Aggregate. */
  const aggregate_value = aggregate(rows);
  if (aggregate_value.response_count === 0) {
    return fail("Survey workbook has no ACTIVE respondents", {
      hint: input.hint,
    });
  }

  /* 5. Emit ONE snapshot. The summary-assembler picks the latest per
     source_type, so re-uploads of the same file just refresh the row. */
  const class_date = ident.class_date;
  return {
    ok: true,
    source_type: SOURCE_TYPE,
    snapshots: [
      {
        source_type: SOURCE_TYPE,
        source_message_id: input.source_message_id,
        source_artifact_id: input.source_artifact_id,
        captured_at: input.received_at,
        class: {
          course_type: ident.course_type,
          class_date,
          location: ident.location,
          /* Survey doesn't carry a roster — list of (FirstName LastName)
             from the export so the delta engine can still hash a stable
             participant set if it matters downstream. */
          participants: collectRespondents(rows),
        },
        source_payload: {
          survey: aggregate_value,
          fixture_filename: input.hint,
        },
      },
    ],
  };
};

function collectRespondents(rows: RawRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r["Status"] && String(r["Status"]).toUpperCase() !== "ACTIVE") continue;
    const fn = (r["First Name"] ?? "").toString().trim();
    const ln = (r["Last Name"] ?? "").toString().trim();
    if (fn || ln) out.add(`${fn} ${ln}`.trim());
  }
  return Array.from(out);
}

export default parseSurvey;

/**
 * Exported for tests + the dashboard's "needs format spec" filter, which
 * keys off the legacy stub message. Now that the parser is real, the
 * filter no longer matches anything — but exporting an empty constant
 * keeps existing imports compiling without churn.
 */
export const SURVEY_STUB_MESSAGE = "";
