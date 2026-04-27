/**
 * Word .docx renderer for porsche-classes AssembledSummary.
 *
 * Mirrors the section ordering and labels of the print-friendly UI at
 * `/automations/[automationId]/summaries/[classKey]` so what the program
 * owner sees on screen matches what she ships to the dealer principal.
 *
 * Body font: Times New Roman 11pt. Headings bold, slightly larger.
 *
 * Sections (in order):
 *   1. Title
 *   2. Class identity (course / date / location / generated_at) — table
 *   3. Participants — bulleted list
 *   4. Coordinator notes — one paragraph per coordinator, bold author lead
 *   5. Instructor notes — same shape
 *   6. Survey rollup — count + average + per-question table (avg + first
 *      3 comments truncated to 200 chars)
 *   7. Open exceptions — only when present, kind + detail
 *
 * Pure: takes an AssembledSummary, returns a Buffer (.docx zip bytes).
 * No DB calls, no auth, no fs. The route handler is the integration
 * boundary — this module is unit-testable in isolation.
 */

import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  HeadingLevel,
  AlignmentType,
  WidthType,
  BorderStyle,
} from "docx";
import type { AssembledSummary, SurveyAggregate } from "../types";

const BODY_FONT = "Times New Roman";
const BODY_SIZE = 22; // half-points → 11pt
const H1_SIZE = 32; // 16pt
const H2_SIZE = 26; // 13pt

// Defensive YYYY-MM-DD formatter. The TS contract on AssembledSummary.class_date
// is `string`, but the SQL read path historically returned a Date object when
// the ::text cast was missing — interpolating with ${} produced
// "Mon Apr 20 2026 00:00:00 GMT+0000 (Coordinated Universal Time)" in the
// uploaded docx (2026-04-27). Cast is now fixed in summary-assembler.ts, but
// keep this guard so any future drift cannot regress the deliverable.
function fmtDate(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

/**
 * docx requires a single Document. Build all children top-down then hand
 * off to Packer.toBuffer at the end.
 */
export async function renderClassSummaryDocx(
  summary: AssembledSummary,
): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  // -------- 1. Title --------
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `PCBA Class Summary — ${summary.course_type} | ${summary.location} | ${fmtDate(summary.class_date)}`,
          bold: true,
          size: H1_SIZE,
          font: BODY_FONT,
        }),
      ],
    }),
  );

  // -------- 2. Class Identity table --------
  children.push(heading("Class Identity"));
  children.push(
    twoColTable([
      ["Course", summary.course_type],
      ["Date", fmtDate(summary.class_date)],
      ["Location", summary.location],
      ["Generated", summary.generated_at],
    ]),
  );
  children.push(blankParagraph());

  // -------- 3. Participants --------
  children.push(heading("Participants"));
  children.push(
    bodyParagraph(`Total: ${summary.participants.length}`, { bold: true }),
  );
  if (summary.participants.length === 0) {
    children.push(
      bodyParagraph("(no roster ingested yet)", { italics: true }),
    );
  } else {
    for (const p of summary.participants) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [
            new TextRun({ text: p, size: BODY_SIZE, font: BODY_FONT }),
          ],
        }),
      );
    }
  }
  children.push(blankParagraph());

  // -------- 4. Coordinator Notes --------
  children.push(heading("Coordinator Notes"));
  if (summary.coordinator_notes.length === 0) {
    children.push(
      bodyParagraph("(no coordinator report received)", { italics: true }),
    );
  } else {
    for (const note of summary.coordinator_notes) {
      children.push(authoredNote(note.author, note.note));
    }
  }
  children.push(blankParagraph());

  // -------- 5. Instructor Notes --------
  children.push(heading("Instructor Notes"));
  if (summary.instructor_notes.length === 0) {
    children.push(
      bodyParagraph("(no instructor report received)", { italics: true }),
    );
  } else {
    for (const note of summary.instructor_notes) {
      children.push(authoredNote(note.author, note.note));
    }
  }
  children.push(blankParagraph());

  // -------- 6. Survey Rollup --------
  children.push(heading("Survey Rollup"));
  children.push(...renderSurvey(summary.survey));
  children.push(blankParagraph());

  // -------- 7. Open Exceptions (only if any) --------
  if (summary.open_exceptions.length > 0) {
    children.push(heading("Open Exceptions"));
    for (const exc of summary.open_exceptions) {
      children.push(
        new Paragraph({
          spacing: { after: 80 },
          children: [
            new TextRun({
              text: `${exc.kind}: `,
              bold: true,
              size: BODY_SIZE,
              font: BODY_FONT,
            }),
            new TextRun({
              text: exc.detail,
              size: BODY_SIZE,
              font: BODY_FONT,
            }),
          ],
        }),
      );
    }
  }

  const doc = new Document({
    creator: "Wolfpack Instinct",
    title: `PCBA Class Summary — ${summary.class_key}`,
    description: "Porsche Academy class summary export",
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: BODY_SIZE },
        },
      },
    },
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/* ------------------------------------------------------------------ */
/* Helpers — keep formatting consistent and the renderer terse.        */
/* ------------------------------------------------------------------ */

function heading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 120 },
    children: [
      new TextRun({
        text,
        bold: true,
        size: H2_SIZE,
        font: BODY_FONT,
      }),
    ],
  });
}

function bodyParagraph(
  text: string,
  opts: { bold?: boolean; italics?: boolean } = {},
): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italics,
        size: BODY_SIZE,
        font: BODY_FONT,
      }),
    ],
  });
}

function blankParagraph(): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: "", size: BODY_SIZE, font: BODY_FONT })],
  });
}

/**
 * "<author>: <note>" with the author bold so the eye can scan a long
 * notes block by author. Multiline note bodies are preserved by
 * inserting break() entries between lines.
 */
function authoredNote(author: string, note: string): Paragraph {
  const lines = (note || "").split("\n");
  const runs: TextRun[] = [
    new TextRun({
      text: `${author}: `,
      bold: true,
      size: BODY_SIZE,
      font: BODY_FONT,
    }),
  ];
  if (lines.length === 0 || (lines.length === 1 && !lines[0])) {
    runs.push(
      new TextRun({
        text: "(no free-text answers)",
        italics: true,
        size: BODY_SIZE,
        font: BODY_FONT,
      }),
    );
  } else {
    runs.push(
      new TextRun({
        text: lines[0],
        size: BODY_SIZE,
        font: BODY_FONT,
      }),
    );
    for (let i = 1; i < lines.length; i++) {
      runs.push(
        new TextRun({
          text: lines[i],
          size: BODY_SIZE,
          font: BODY_FONT,
          break: 1,
        }),
      );
    }
  }
  return new Paragraph({ spacing: { after: 160 }, children: runs });
}

/**
 * Two-column "label | value" table (Class Identity).
 */
function twoColTable(rows: ReadonlyArray<readonly [string, string]>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: 30, type: WidthType.PERCENTAGE },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: label,
                      bold: true,
                      size: BODY_SIZE,
                      font: BODY_FONT,
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              width: { size: 70, type: WidthType.PERCENTAGE },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: value,
                      size: BODY_SIZE,
                      font: BODY_FONT,
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

/**
 * Survey rollup → a header line (responses + average) plus a per-question
 * table whose 3rd column lists up to 3 comments truncated at 200 chars.
 *
 * When `survey` is null we render the same "(survey integration pending)"
 * note the UI uses, so the dealer principal sees a consistent message
 * regardless of channel.
 */
function renderSurvey(survey: SurveyAggregate | null): (Paragraph | Table)[] {
  if (!survey) {
    return [
      bodyParagraph("(survey integration pending)", { italics: true }),
    ];
  }
  const out: (Paragraph | Table)[] = [];
  out.push(bodyParagraph(`Responses: ${survey.response_count}`, { bold: true }));
  if (survey.average_score !== null) {
    out.push(
      bodyParagraph(`Average: ${survey.average_score.toFixed(2)} / 5`, {
        bold: true,
      }),
    );
  }
  if (survey.questions.length > 0) {
    out.push(
      surveyTable(
        survey.questions.map((q) => ({
          question: q.question,
          average:
            q.average !== null && q.average !== undefined
              ? `${q.average.toFixed(2)} / 5`
              : "—",
          comments: (q.comments ?? [])
            .slice(0, 3)
            .map((c) => truncate(c, 200)),
        })),
      ),
    );
  }
  return out;
}

function surveyTable(
  rows: Array<{ question: string; average: string; comments: string[] }>,
): Table {
  const header = new TableRow({
    tableHeader: true,
    children: ["Question", "Average", "Top comments"].map(
      (label) =>
        new TableCell({
          shading: { fill: "EEEEEE" },
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: label,
                  bold: true,
                  size: BODY_SIZE,
                  font: BODY_FONT,
                }),
              ],
            }),
          ],
        }),
    ),
  });
  const body = rows.map(
    (r) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: 45, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: r.question,
                    size: BODY_SIZE,
                    font: BODY_FONT,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: r.average,
                    size: BODY_SIZE,
                    font: BODY_FONT,
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: 40, type: WidthType.PERCENTAGE },
            children:
              r.comments.length === 0
                ? [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: "—",
                          italics: true,
                          size: BODY_SIZE,
                          font: BODY_FONT,
                        }),
                      ],
                    }),
                  ]
                : r.comments.map(
                    (c) =>
                      new Paragraph({
                        bullet: { level: 0 },
                        children: [
                          new TextRun({
                            text: c,
                            size: BODY_SIZE,
                            font: BODY_FONT,
                          }),
                        ],
                      }),
                  ),
          }),
        ],
      }),
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "999999" },
      insideHorizontal: {
        style: BorderStyle.SINGLE,
        size: 4,
        color: "CCCCCC",
      },
      insideVertical: {
        style: BorderStyle.SINGLE,
        size: 4,
        color: "CCCCCC",
      },
    },
    rows: [header, ...body],
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
