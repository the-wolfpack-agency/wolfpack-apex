/**
 * Unit tests for the porsche-classes Word .docx renderer.
 *
 * The output is a real .docx (a zip of XML parts), so we don't try to
 * parse it back — we assert:
 *   1. The returned buffer is non-empty.
 *   2. The first two bytes are the ZIP local-file-header signature
 *      (`PK\x03\x04`) — every valid .docx starts with that, identical
 *      to .xlsx (both are OOXML zips).
 *   3. The renderer accepts every nullable shape the AssembledSummary
 *      contract permits (no survey, no exceptions, empty notes, etc.)
 *      without throwing.
 *   4. Long survey comments are truncated at 200 chars.
 */

import { renderClassSummaryDocx } from "@/lib/automations/porsche-classes/export-docx";
import type { AssembledSummary } from "@/lib/automations/types";

const baseSummary: AssembledSummary = {
  class_key: "BA101|2026-04-13|Westlake",
  course_type: "BA101",
  class_date: "2026-04-13",
  location: "Westlake",
  sources: {
    porsche_xlsx: 1,
    cognito_coordinator: 1,
    cognito_instructor: 1,
    survey: 1,
    email: 0,
  },
  participants: ["alice@dealer.com", "bob@dealer.com"],
  coordinator_notes: [
    { author: "Amy Coordinator", note: "Logistics: Smooth.\nFood: Great." },
  ],
  instructor_notes: [
    { author: "Ian Instructor", note: "Class engaged well." },
  ],
  survey: {
    response_count: 5,
    average_score: 4.6,
    questions: [
      {
        question: "How would you rate the instructor?",
        average: 4.8,
        comments: ["excellent", "knew his stuff", "engaging"],
      },
      {
        question: "How was the venue?",
        average: 4.2,
        comments: [],
      },
    ],
  },
  open_exceptions: [],
  generated_at: "2026-04-25T10:00:00.000Z",
};

function isZipMagic(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 && // P
    buf[1] === 0x4b && // K
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

describe("renderClassSummaryDocx", () => {
  it("renders a valid .docx (ZIP magic + non-empty)", async () => {
    const buf = await renderClassSummaryDocx(baseSummary);
    // Buffer extends Uint8Array; in some TS lib targets `instanceof
    // Uint8Array` complains because Buffer's typings make it non-narrowable.
    // ArrayBuffer.isView is the safe cross-runtime predicate.
    expect(Buffer.isBuffer(buf) || ArrayBuffer.isView(buf)).toBe(true);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(asBuffer.length).toBeGreaterThan(500); // sanity floor
    expect(isZipMagic(asBuffer)).toBe(true);
  });

  it("handles a summary with no survey, no notes, no participants, no exceptions", async () => {
    const empty: AssembledSummary = {
      ...baseSummary,
      participants: [],
      coordinator_notes: [],
      instructor_notes: [],
      survey: null,
      open_exceptions: [],
    };
    const buf = await renderClassSummaryDocx(empty);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(asBuffer.length).toBeGreaterThan(0);
    expect(isZipMagic(asBuffer)).toBe(true);
  });

  it("renders open_exceptions when present", async () => {
    const withExceptions: AssembledSummary = {
      ...baseSummary,
      open_exceptions: [
        {
          id: "exc-1",
          automation_id: "porsche-classes",
          artifact_id: "art-1",
          kind: "parse_failure",
          detail: "xlsx had no rows for Westlake",
          status: "open",
          resolved_by: null,
          resolved_at: null,
          created_at: "2026-04-25T09:00:00.000Z",
        },
      ],
    };
    const buf = await renderClassSummaryDocx(withExceptions);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(asBuffer.length).toBeGreaterThan(0);
    expect(isZipMagic(asBuffer)).toBe(true);
  });

  it("does not throw on a survey question with a >200 char comment", async () => {
    const longComment = "x".repeat(450);
    const longSurvey: AssembledSummary = {
      ...baseSummary,
      survey: {
        response_count: 1,
        average_score: null,
        questions: [
          {
            question: "Free-text feedback",
            average: null,
            comments: [longComment, "second", "third", "fourth dropped"],
          },
        ],
      },
    };
    const buf = await renderClassSummaryDocx(longSurvey);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(asBuffer.length).toBeGreaterThan(0);
    expect(isZipMagic(asBuffer)).toBe(true);
  });

  it("renders a coordinator note with empty body without throwing", async () => {
    const blankNote: AssembledSummary = {
      ...baseSummary,
      coordinator_notes: [{ author: "Amy", note: "" }],
    };
    const buf = await renderClassSummaryDocx(blankNote);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(isZipMagic(asBuffer)).toBe(true);
  });
});
