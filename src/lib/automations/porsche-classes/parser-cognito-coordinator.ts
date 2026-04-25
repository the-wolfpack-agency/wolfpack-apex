/**
 * Cognito "Coordinator Class Report" email parser.
 *
 * Wired into the Automations contract via `Parser` from `types.ts`.
 * Pure: takes raw .eml bytes and returns either a single ParseSuccess
 * (one snapshot per email) or a ParseFailure that the ingest
 * orchestrator will turn into an exception row for the program owner to review.
 *
 * Why this parser is "label-table, not regex-on-text":
 *   The text/plain body Cognito ships has no delimiters between fields,
 *   so any regex is one new question away from a silent miss. The
 *   text/html body is a stable label/value table that maps cleanly
 *   onto our snapshot shape. See `cognito-html.ts` for the helper.
 *
 * Field map (Coordinator form, as of 2026-04-20):
 *
 *   Entry Details
 *     Name                                              -> coordinator_name
 *     Email                                             -> coordinator_email
 *     Class Date                                        -> class_date (ISO)
 *     Class                                             -> course_type ("BA101"|"BA102")
 *     Class Location                                    -> location (title-case)
 *     Total number of participants                      -> participant_count
 *     Were there any no shows?                          -> no_shows
 *     Please list name & dealership of no shows         -> no_show_details
 *     Did anyone from PCNA attend your class?           -> pcna_attended
 *     Who from PCNA Attended?...                        -> pcna_attendees
 *     Did you take the class pic?                       -> class_pic_taken
 *     Did you enter any PMA points?                     -> pma_points_entered
 *     Did you enter anything in CRM?                    -> crm_entered
 *
 *   Hotel Experience, Dinner Outing, Transportation, General Class
 *   Logistics — kept verbatim under their section heading inside
 *   `source_payload.sections`. The full byLabel map is in
 *   `source_payload.fields` for downstream consumers (e.g. the summary
 *   renderer).
 *
 * `participants: []` because the Coordinator form does NOT enumerate
 * attendee names — it gives a count + the no-show list. The canonical
 * participant list comes from the porsche_xlsx parser. The summary
 * assembler joins the two.
 */

import type {
  ParseInput,
  ParseResult,
  Parser,
  CourseType,
} from "../types";
import {
  buildClassKey,
  extractEmlParts,
  normalizeClassDate,
  normalizeLocation,
  parseCognitoHtml,
  collapseWs,
} from "./cognito-html";

const SOURCE_TYPE = "cognito_coordinator" as const;

const COURSE_VALUES: CourseType[] = ["BA101", "BA102"];

function asCourseType(raw: string): CourseType | null {
  const upper = raw.trim().toUpperCase().replace(/\s+/g, "");
  return (COURSE_VALUES as string[]).includes(upper)
    ? (upper as CourseType)
    : null;
}

function fail(
  error: string,
  detail?: Record<string, unknown>,
): ParseResult {
  return {
    ok: false,
    source_type: SOURCE_TYPE,
    error,
    exception_kind: "parse_failure",
    detail,
  };
}

function missingField(
  field: string,
  detail?: Record<string, unknown>,
): ParseResult {
  return {
    ok: false,
    source_type: SOURCE_TYPE,
    error: `Coordinator email missing required field: ${field}`,
    exception_kind: "missing_field",
    detail,
  };
}

export const parseCognitoCoordinator: Parser = async (
  input: ParseInput,
): Promise<ParseResult> => {
  const parts = extractEmlParts(input.bytes);
  if (!parts.html) {
    return fail("Coordinator email has no text/html part to parse", {
      hint: input.hint,
      has_text: parts.text !== null,
    });
  }

  const subject = parts.subject ?? input.hint ?? "";
  if (!/Coordinator Class Report/i.test(subject)) {
    return fail(
      `Subject does not match Coordinator Class Report pattern: "${subject}"`,
      { subject },
    );
  }

  const fields = parseCognitoHtml(parts.html);
  if (
    !fields.formTitle ||
    !/Coordinator Class Report/i.test(fields.formTitle)
  ) {
    return fail(
      `Form title does not match Coordinator Class Report: "${fields.formTitle ?? "<missing>"}"`,
      { formTitle: fields.formTitle },
    );
  }

  // Required fields for class identity.
  const courseRaw = fields.byLabel["Class"];
  const dateRaw = fields.byLabel["Class Date"];
  const locationRaw = fields.byLabel["Class Location"];
  if (!courseRaw) return missingField("Class");
  if (!dateRaw) return missingField("Class Date");
  if (!locationRaw) return missingField("Class Location");

  const courseType = asCourseType(courseRaw);
  if (!courseType) {
    return fail(`Unknown course type: "${courseRaw}"`, { course: courseRaw });
  }
  const classDate = normalizeClassDate(dateRaw);
  if (!classDate) {
    return fail(`Could not parse Class Date: "${dateRaw}"`, {
      class_date: dateRaw,
    });
  }
  const location = normalizeLocation(locationRaw);

  // Pull the coordinator identity off the form (used in the summary
  // renderer's "coordinator notes per coordinator" rollup).
  const coordinatorName = fields.byLabel["Name"]
    ? collapseWs(fields.byLabel["Name"])
    : null;
  const coordinatorEmail = fields.byLabel["Email"]
    ? collapseWs(fields.byLabel["Email"])
    : null;

  // Convert participant_count to a number when present (defensive).
  const participantCountRaw = fields.byLabel["Total number of participants"];
  const participantCount = participantCountRaw
    ? Number(participantCountRaw.replace(/[^\d-]/g, ""))
    : null;

  const sourcePayload: Record<string, unknown> = {
    coordinator_name: coordinatorName,
    coordinator_email: coordinatorEmail,
    participant_count: Number.isFinite(participantCount)
      ? participantCount
      : null,
    // Whole label-keyed flat map (the renderer iterates this verbatim).
    fields: fields.byLabel,
    // Section-grouped view (preserves form order and section headings).
    sections: fields.sections,
    // Subject + class_key fragments so downstream consumers don't have
    // to re-parse the .eml just to render a header.
    subject,
    form_title: fields.formTitle,
  };

  const classKey = buildClassKey(courseType, classDate, location);
  const capturedAt = parts.date
    ? new Date(parts.date).toISOString()
    : input.received_at;

  return {
    ok: true,
    source_type: SOURCE_TYPE,
    snapshots: [
      {
        source_type: SOURCE_TYPE,
        source_message_id: parts.message_id ?? input.source_message_id,
        source_artifact_id: input.source_artifact_id,
        captured_at: capturedAt,
        class: {
          course_type: courseType,
          class_date: classDate,
          location,
          // Coordinator form does NOT enumerate attendees — see header
          // comment. Class-level participant list comes from the xlsx
          // parser; the summary assembler joins them.
          participants: [],
        },
        source_payload: {
          ...sourcePayload,
          class_key: classKey,
        },
      },
    ],
  };
};

export default parseCognitoCoordinator;
