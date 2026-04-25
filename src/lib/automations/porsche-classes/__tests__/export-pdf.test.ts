/**
 * Unit tests for the porsche-classes native PDF renderer.
 *
 * The output is a real PDF (PDFKit-produced bytes), so we don't try to
 * parse it back — we assert:
 *   1. The returned buffer is non-empty.
 *   2. The first 5 bytes are the PDF magic `%PDF-` — every valid PDF
 *      starts with that header.
 *   3. The renderer accepts every nullable shape the AssembledSummary
 *      contract permits (no survey, no exceptions, empty notes,
 *      no participants) without throwing.
 *   4. Long survey comments are truncated at 200 chars (no throw on
 *      a 450-char comment).
 *   5. Empty coordinator notes don't crash the renderer.
 */

import { renderClassSummaryPdf } from "@/lib/automations/porsche-classes/export-pdf";
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

function isPdfMagic(buf: Buffer): boolean {
  // PDF spec §7.5.2: every file starts with "%PDF-" (0x25 0x50 0x44 0x46 0x2D).
  return (
    buf.length >= 5 &&
    buf[0] === 0x25 && // %
    buf[1] === 0x50 && // P
    buf[2] === 0x44 && // D
    buf[3] === 0x46 && // F
    buf[4] === 0x2d // -
  );
}

describe("renderClassSummaryPdf", () => {
  // PDF rendering is heavier than .docx (PDFKit lays out font metrics,
  // streams, etc.) — give jest a generous slice for these.
  jest.setTimeout(20_000);

  it("renders a valid PDF (PDF magic + non-empty)", async () => {
    const buf = await renderClassSummaryPdf(baseSummary);
    // Buffer extends Uint8Array; ArrayBuffer.isView is the safe
    // cross-runtime predicate (matches the .docx sibling test).
    expect(Buffer.isBuffer(buf) || ArrayBuffer.isView(buf)).toBe(true);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(asBuffer.length).toBeGreaterThan(500); // sanity floor
    expect(isPdfMagic(asBuffer)).toBe(true);
    // Belt and suspenders: also accept the textual prefix.
    expect(asBuffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
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
    const buf = await renderClassSummaryPdf(empty);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(asBuffer.length).toBeGreaterThan(0);
    expect(isPdfMagic(asBuffer)).toBe(true);
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
    const buf = await renderClassSummaryPdf(withExceptions);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(asBuffer.length).toBeGreaterThan(0);
    expect(isPdfMagic(asBuffer)).toBe(true);
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
    const buf = await renderClassSummaryPdf(longSurvey);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(asBuffer.length).toBeGreaterThan(0);
    expect(isPdfMagic(asBuffer)).toBe(true);
  });

  it("renders a coordinator note with empty body without throwing", async () => {
    const blankNote: AssembledSummary = {
      ...baseSummary,
      coordinator_notes: [{ author: "Amy", note: "" }],
    };
    const buf = await renderClassSummaryPdf(blankNote);
    const asBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    expect(isPdfMagic(asBuffer)).toBe(true);
  });
});
