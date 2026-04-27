/**
 * Native PDF renderer for porsche-classes AssembledSummary.
 *
 * One-click "Download PDF" companion to `export-docx.ts`. Mirrors the
 * SAME section ordering and labels so the program owner gets a
 * pixel-equivalent message regardless of whether she ships .docx or .pdf.
 *
 * Why @react-pdf/renderer rather than headless-Chrome / Puppeteer?
 *   - Pure JS, no Chromium binary, no cold-start tax on Vercel
 *     serverless. PDF bytes are produced in-process via PDFKit.
 *   - Same "render a tree to a Buffer" shape as docx, so the route
 *     handler stays a thin auth + pipe layer.
 *
 * Body font: Times-Roman (the @react-pdf default Times serif).
 * Headings: Times-Bold, larger.
 *
 * Sections (in order — must match export-docx.ts):
 *   1. Title
 *   2. Class identity (course / date / location / generated_at) — 2-col rows
 *   3. Participants — bulleted list
 *   4. Coordinator notes — one block per coordinator, bold author lead
 *   5. Instructor notes — same shape
 *   6. Survey rollup — count + average + per-question table
 *   7. Open exceptions — only when present, kind + detail
 *
 * Pure: takes an AssembledSummary, returns a Buffer (PDF bytes).
 * No DB, no auth, no fs. The route handler is the integration boundary —
 * this module is unit-testable in isolation.
 */

import * as React from "react";
import type { AssembledSummary, SurveyAggregate } from "../types";

const BODY_FONT = "Times-Roman";
const BODY_BOLD = "Times-Bold";
const BODY_ITALIC = "Times-Italic";
const BODY_SIZE = 11;
const H1_SIZE = 16;
const H2_SIZE = 13;

// See export-docx.ts for the full rationale — keep these two formatters in
// sync. Defensive coercion of class_date so a Date that slips through (the
// pg driver hydrates `date` columns as Date) cannot leak into the PDF.
function fmtDate(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

// `e` is a thin wrapper around React.createElement typed loosely so we
// can hand it @react-pdf primitive types (which the upstream typings
// expose as class components with strict prop unions). Renderer output
// is verified by tests + Vercel build, not by strict prop typing here.
const e = React.createElement as unknown as (
  type: unknown,
  props?: unknown,
  ...children: unknown[]
) => React.ReactElement;

/**
 * @react-pdf/renderer is ESM-only. The rest of this codebase compiles
 * down to commonjs (Next.js + ts-jest). To avoid forcing the whole
 * jest config + Next bundler into ESM gymnastics, we lazy-load the
 * renderer at first call via a dynamic import that's hidden from the
 * commonjs compiler (the `Function` indirection sidesteps ts-jest's
 * `import()` -> `Promise.resolve().then(() => require())` rewrite).
 *
 * Result: Node loads `@react-pdf/renderer` natively as ESM the first
 * time the route is hit, regardless of whether the caller is itself
 * commonjs. This is the standard "import an ESM-only package from a
 * CJS surface" pattern.
 */
type ReactPDFModule = typeof import("@react-pdf/renderer");
let cachedModule: ReactPDFModule | null = null;
async function loadReactPdf(): Promise<ReactPDFModule> {
  if (cachedModule) return cachedModule;
  /* serverExternalPackages in next.config.ts excludes
     @react-pdf/renderer from the Webpack bundle, so a normal dynamic
     import resolves through Node's native ESM loader at request time.
     The previous `new Function("return import(specifier)")` workaround
     existed for the bundled-package case and broke on Vercel runtime
     because Webpack's chunk-loader couldn't resolve the path. */
  cachedModule = (await import("@react-pdf/renderer")) as ReactPDFModule;
  return cachedModule;
}

interface RPDFStyle {
  [key: string]: string | number | undefined;
}

function buildStyles(StyleSheet: ReactPDFModule["StyleSheet"]) {
  return StyleSheet.create({
    page: {
      paddingTop: 48,
      paddingBottom: 48,
      paddingLeft: 56,
      paddingRight: 56,
      fontFamily: BODY_FONT,
      fontSize: BODY_SIZE,
      color: "#111111",
      lineHeight: 1.4,
    },
    title: {
      fontFamily: BODY_BOLD,
      fontSize: H1_SIZE,
      textAlign: "center",
      marginBottom: 14,
    },
    h2: {
      fontFamily: BODY_BOLD,
      fontSize: H2_SIZE,
      marginTop: 12,
      marginBottom: 6,
    },
    paragraph: {
      marginBottom: 4,
    },
    italic: {
      fontFamily: BODY_ITALIC,
      color: "#555555",
    },
    bold: {
      fontFamily: BODY_BOLD,
    },
    blank: {
      height: 6,
    },
    // Identity table — two columns, label/value
    identityRow: {
      flexDirection: "row",
      borderBottom: "1pt solid #cccccc",
      paddingTop: 3,
      paddingBottom: 3,
    },
    identityLabel: {
      width: "30%",
      fontFamily: BODY_BOLD,
    },
    identityValue: {
      width: "70%",
    },
    bulletRow: {
      flexDirection: "row",
      marginBottom: 2,
    },
    bulletDot: {
      width: 12,
      textAlign: "center",
    },
    bulletText: {
      flex: 1,
    },
    noteBlock: {
      marginBottom: 8,
    },
    surveyHeader: {
      flexDirection: "row",
      backgroundColor: "#eeeeee",
      paddingTop: 4,
      paddingBottom: 4,
      paddingLeft: 4,
      paddingRight: 4,
      borderBottom: "1pt solid #999999",
    },
    surveyRow: {
      flexDirection: "row",
      paddingTop: 4,
      paddingBottom: 4,
      paddingLeft: 4,
      paddingRight: 4,
      borderBottom: "1pt solid #cccccc",
    },
    surveyHeaderText: {
      fontFamily: BODY_BOLD,
    },
    surveyColQuestion: {
      width: "45%",
      paddingRight: 6,
    },
    surveyColAverage: {
      width: "15%",
      paddingRight: 6,
    },
    surveyColComments: {
      width: "40%",
    },
    exceptionRow: {
      flexDirection: "row",
      marginBottom: 3,
    },
  });
}

/**
 * Build the AssembledSummary into a @react-pdf React tree, then hand off
 * to renderToBuffer which streams PDF bytes from PDFKit and resolves to
 * a Buffer. No JSX — keep this file `.ts`-clean and avoid pulling JSX
 * through the existing jest/ts-jest pipeline.
 */
export async function renderClassSummaryPdf(
  summary: AssembledSummary,
): Promise<Buffer> {
  const reactPdf = await loadReactPdf();
  const { Document, Page, View, Text, StyleSheet, renderToBuffer } = reactPdf;
  const styles = buildStyles(StyleSheet) as Record<string, RPDFStyle>;

  const children: React.ReactNode[] = [];

  // -------- 1. Title --------
  children.push(
    e(
      Text,
      { style: styles.title, key: "title" },
      `PCBA Class Summary — ${summary.course_type} | ${summary.location} | ${fmtDate(summary.class_date)}`,
    ),
  );

  // -------- 2. Class Identity --------
  children.push(e(Text, { style: styles.h2, key: "h2-identity" }, "Class Identity"));
  children.push(
    e(
      View,
      { key: "identity-table" },
      identityRow(View, Text, styles, "Course", summary.course_type, "row-course"),
      identityRow(View, Text, styles, "Date", fmtDate(summary.class_date), "row-date"),
      identityRow(View, Text, styles, "Location", summary.location, "row-location"),
      identityRow(View, Text, styles, "Generated", summary.generated_at, "row-generated"),
    ),
  );
  children.push(e(View, { style: styles.blank, key: "blank-1" }));

  // -------- 3. Participants --------
  children.push(e(Text, { style: styles.h2, key: "h2-participants" }, "Participants"));
  children.push(
    e(
      Text,
      { style: [styles.paragraph, styles.bold], key: "participants-total" },
      `Total: ${summary.participants.length}`,
    ),
  );
  if (summary.participants.length === 0) {
    children.push(
      e(
        Text,
        { style: [styles.paragraph, styles.italic], key: "participants-empty" },
        "(no roster ingested yet)",
      ),
    );
  } else {
    summary.participants.forEach((p, i) => {
      children.push(
        e(
          View,
          { style: styles.bulletRow, key: `participant-${i}` },
          e(Text, { style: styles.bulletDot }, "•"),
          e(Text, { style: styles.bulletText }, p),
        ),
      );
    });
  }
  children.push(e(View, { style: styles.blank, key: "blank-2" }));

  // -------- 4. Coordinator Notes --------
  children.push(e(Text, { style: styles.h2, key: "h2-coord" }, "Coordinator Notes"));
  if (summary.coordinator_notes.length === 0) {
    children.push(
      e(
        Text,
        { style: [styles.paragraph, styles.italic], key: "coord-empty" },
        "(no coordinator report received)",
      ),
    );
  } else {
    summary.coordinator_notes.forEach((note, i) => {
      children.push(authoredNote(View, Text, styles, note.author, note.note, `coord-${i}`));
    });
  }
  children.push(e(View, { style: styles.blank, key: "blank-3" }));

  // -------- 5. Instructor Notes --------
  children.push(e(Text, { style: styles.h2, key: "h2-instr" }, "Instructor Notes"));
  if (summary.instructor_notes.length === 0) {
    children.push(
      e(
        Text,
        { style: [styles.paragraph, styles.italic], key: "instr-empty" },
        "(no instructor report received)",
      ),
    );
  } else {
    summary.instructor_notes.forEach((note, i) => {
      children.push(authoredNote(View, Text, styles, note.author, note.note, `instr-${i}`));
    });
  }
  children.push(e(View, { style: styles.blank, key: "blank-4" }));

  // -------- 6. Survey Rollup --------
  children.push(e(Text, { style: styles.h2, key: "h2-survey" }, "Survey Rollup"));
  for (const node of renderSurvey(View, Text, styles, summary.survey)) {
    children.push(node);
  }
  children.push(e(View, { style: styles.blank, key: "blank-5" }));

  // -------- 7. Open Exceptions (only if any) --------
  if (summary.open_exceptions.length > 0) {
    children.push(e(Text, { style: styles.h2, key: "h2-exc" }, "Open Exceptions"));
    summary.open_exceptions.forEach((exc, i) => {
      children.push(
        e(
          View,
          { style: styles.exceptionRow, key: `exc-${i}` },
          e(
            Text,
            null,
            e(Text, { style: styles.bold }, `${exc.kind}: `),
            e(Text, null, exc.detail),
          ),
        ),
      );
    });
  }

  const doc = e(
    Document,
    {
      title: `PCBA Class Summary — ${summary.class_key}`,
      author: "Wolfpack Instinct",
      subject: "Porsche Academy class summary export",
    },
    e(Page, { size: "LETTER", style: styles.page }, ...children),
  );

  // renderToBuffer returns Promise<Buffer> in Node.
  // Cast: see the `e` factory comment above — @react-pdf primitive
  // typings collide with React.createElement's overloads but the runtime
  // shape is correct (verified by both unit + route tests).
  return renderToBuffer(
    doc as unknown as Parameters<ReactPDFModule["renderToBuffer"]>[0],
  );
}

/* ------------------------------------------------------------------ */
/* Helpers — keep formatting consistent and the renderer terse.        */
/* ------------------------------------------------------------------ */

function identityRow(
  View: ReactPDFModule["View"],
  Text: ReactPDFModule["Text"],
  styles: Record<string, RPDFStyle>,
  label: string,
  value: string,
  key: string,
): React.ReactElement {
  return e(
    View,
    { style: styles.identityRow, key },
    e(Text, { style: styles.identityLabel }, label),
    e(Text, { style: styles.identityValue }, value),
  );
}

/**
 * "<author>: <note>" with the author bold so the eye can scan a long
 * notes block by author. Multiline note bodies render via embedded `\n`
 * inside a Text — @react-pdf preserves explicit newlines.
 */
function authoredNote(
  View: ReactPDFModule["View"],
  Text: ReactPDFModule["Text"],
  styles: Record<string, RPDFStyle>,
  author: string,
  note: string,
  key: string,
): React.ReactElement {
  const trimmed = note ?? "";
  if (!trimmed) {
    return e(
      View,
      { style: styles.noteBlock, key },
      e(
        Text,
        null,
        e(Text, { style: styles.bold }, `${author}: `),
        e(Text, { style: styles.italic }, "(no free-text answers)"),
      ),
    );
  }
  return e(
    View,
    { style: styles.noteBlock, key },
    e(
      Text,
      null,
      e(Text, { style: styles.bold }, `${author}: `),
      e(Text, null, trimmed),
    ),
  );
}

/**
 * Survey rollup → a header line (responses + average) plus a per-question
 * table whose 3rd column lists up to 3 comments truncated at 200 chars.
 *
 * When `survey` is null we render the same "(survey integration pending)"
 * note the UI uses.
 */
function renderSurvey(
  View: ReactPDFModule["View"],
  Text: ReactPDFModule["Text"],
  styles: Record<string, RPDFStyle>,
  survey: SurveyAggregate | null,
): React.ReactElement[] {
  if (!survey) {
    return [
      e(
        Text,
        { style: [styles.paragraph, styles.italic], key: "survey-pending" },
        "(survey integration pending)",
      ),
    ];
  }
  const out: React.ReactElement[] = [];
  out.push(
    e(
      Text,
      { style: [styles.paragraph, styles.bold], key: "survey-count" },
      `Responses: ${survey.response_count}`,
    ),
  );
  if (survey.average_score !== null) {
    out.push(
      e(
        Text,
        { style: [styles.paragraph, styles.bold], key: "survey-avg" },
        `Average: ${survey.average_score.toFixed(2)} / 5`,
      ),
    );
  }
  if (survey.questions.length > 0) {
    out.push(
      e(
        View,
        { key: "survey-table" },
        // Header
        e(
          View,
          { style: styles.surveyHeader, key: "survey-th" },
          e(
            Text,
            { style: [styles.surveyColQuestion, styles.surveyHeaderText] },
            "Question",
          ),
          e(
            Text,
            { style: [styles.surveyColAverage, styles.surveyHeaderText] },
            "Average",
          ),
          e(
            Text,
            { style: [styles.surveyColComments, styles.surveyHeaderText] },
            "Top comments",
          ),
        ),
        // Rows
        ...survey.questions.map((q, i) => {
          const avgStr =
            q.average !== null && q.average !== undefined
              ? `${q.average.toFixed(2)} / 5`
              : "—";
          const comments = (q.comments ?? [])
            .slice(0, 3)
            .map((c) => truncate(c, 200));
          return e(
            View,
            { style: styles.surveyRow, key: `survey-row-${i}` },
            e(Text, { style: styles.surveyColQuestion }, q.question),
            e(Text, { style: styles.surveyColAverage }, avgStr),
            e(
              View,
              { style: styles.surveyColComments },
              comments.length === 0
                ? e(Text, { style: styles.italic }, "—")
                : comments.map((c, j) =>
                    e(
                      View,
                      { style: styles.bulletRow, key: `c-${i}-${j}` },
                      e(Text, { style: styles.bulletDot }, "•"),
                      e(Text, { style: styles.bulletText }, c),
                    ),
                  ),
            ),
          );
        }),
      ),
    );
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
