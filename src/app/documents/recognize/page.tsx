/**
 * /documents/recognize — document recognition surface.
 *
 * Server-component entry. Renders the client view that drives the
 * full pipeline:
 *
 *   1. User drops a file (image or PDF).
 *   2. Client POSTs multipart to /api/documents/recognize.
 *   3. Server runs classifier → router → extractor → persistence.
 *   4. Client renders the classification + extracted fields.
 *   5. Optional reclassify writes back via PATCH /[id].
 *
 * Auth gate lives in the client component (it needs window-level
 * access to the localStorage token). Per CLAUDE.md every authed page
 * must redirect unauth users — never render an empty page.
 */
import type { Metadata } from "next";
import { RecognizeView } from "./RecognizeView";

export const metadata: Metadata = {
  title: "Document Recognition — Wolfpack Instinct",
  description:
    "Drop a receipt, invoice, W-2, 1099, or ID and Instinct will classify it and extract the structured fields.",
};

export default function DocumentsRecognizePage() {
  return (
    <main
      className="flex-1 p-4 md:p-6"
      data-testid="documents-recognize-page"
    >
      <header className="mb-4">
        <h1
          className="text-2xl font-semibold"
          style={{ color: "var(--wp-text, #eee)" }}
        >
          Document Recognition
        </h1>
        <p
          className="text-sm mt-1 max-w-3xl"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          Drop a receipt, invoice, tax form (W-2 or 1099), or ID document
          here. Instinct classifies the document, then runs the right
          extractor to pull out the structured fields. Sensitive content
          is detected before any vendor call.
        </p>
      </header>
      <RecognizeView />
    </main>
  );
}
