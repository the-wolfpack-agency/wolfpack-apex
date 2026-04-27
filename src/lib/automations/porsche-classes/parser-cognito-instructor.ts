/**
 * Cognito "Instructor Class Report" email parser.
 *
 * Same email template as the Coordinator form (see
 * `parser-cognito-coordinator.ts` for the rationale on HTML-over-text)
 * but a different question set: the instructor reports on technical
 * difficulties, content issues, surprise/delight moments, and free-text
 * suggestions for future training. The class identity fields (Class /
 * Class Date / Class Location) are identical.
 *
 * As with the coordinator parser, `participants: []` because the
 * instructor form does NOT enumerate attendees. The summary assembler
 * joins this snapshot's `source_payload` (with the instructor's name)
 * to the canonical participant list from the porsche_xlsx parser.
 */

import type {
  ParseInput,
  ParseResult,
  Parser,
  CourseType,
} from "../types";
import {
  buildClassKey,
  collapseWs,
  extractEmlParts,
  normalizeClassDate,
  normalizeLocation,
  parseCognitoHtml,
} from "./cognito-html";

const SOURCE_TYPE = "cognito_instructor" as const;

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
    error: `Instructor email missing required field: ${field}`,
    exception_kind: "missing_field",
    detail,
  };
}

export const parseCognitoInstructor: Parser = async (
  input: ParseInput,
): Promise<ParseResult> => {
  const parts = extractEmlParts(input.bytes);
  if (!parts.html) {
    return fail("Instructor email has no text/html part to parse", {
      hint: input.hint,
      has_text: parts.text !== null,
    });
  }

  const subject = parts.subject ?? input.hint ?? "";
  if (!/Instructor Class Report/i.test(subject)) {
    return fail(
      `Subject does not match Instructor Class Report pattern: "${subject}"`,
      { subject },
    );
  }

  const fields = parseCognitoHtml(parts.html);
  /* Soft signal — see parser-cognito-coordinator for full rationale.
     Subject (validated above) is the primary identifier; Outlook's
     "Save as .eml" frequently strips the form-title h2. */
  if (
    !fields.formTitle ||
    !/Instructor Class Report/i.test(fields.formTitle)
  ) {
    console.warn(
      `[parser-cognito-instructor] form-title h2 missing or mismatched ` +
        `(subject already validated) — saw: "${fields.formTitle ?? "<missing>"}"`,
    );
  }

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

  const instructorName = fields.byLabel["Name"]
    ? collapseWs(fields.byLabel["Name"])
    : null;
  const instructorEmail = fields.byLabel["Email"]
    ? collapseWs(fields.byLabel["Email"])
    : null;

  const sourcePayload: Record<string, unknown> = {
    instructor_name: instructorName,
    instructor_email: instructorEmail,
    fields: fields.byLabel,
    sections: fields.sections,
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
          // Instructor form lists no attendees — see header comment.
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

export default parseCognitoInstructor;
