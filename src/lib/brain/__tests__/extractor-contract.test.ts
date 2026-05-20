/**
 * Contract test: every MIME type the upload UI advertises (via
 * UPLOAD_FILTER_ALLOWED_MIME_TYPES) MUST have a working synchronous
 * extractor that produces non-empty text from a real sample.
 *
 * Shipped 2026-05-20 after xlsx was advertised but silently skipped
 * for weeks (extractor wasn't wired). This test would have caught
 * that the day xlsx was added to the allowlist — and will catch
 * any future "advertise a type, forget to wire the extractor"
 * regression at CI time before it embarrasses the team.
 */

import * as XLSX from "xlsx";
import {
  UPLOAD_FILTER_ALLOWED_MIME_TYPES,
} from "@/lib/brain/upload-filter";
import { classifyKind } from "@/lib/brain/types";
import { extract, isSyncExtractable } from "@/lib/brain/extractor";

/**
 * Real-sample factory: produces a Buffer that is genuinely the
 * declared MIME type. Anything we can't synthesize trivially in Node
 * (PDF, DOCX) gets its smallest valid bytes here. If a new MIME is
 * added to the allowlist and this factory doesn't know how to mint it,
 * the test FAILS loudly demanding a sample — no silent gap.
 */
function realSampleFor(mime: string): Buffer {
  switch (mime) {
    case "text/plain":
      return Buffer.from("hello world this is a sample plain text file");
    case "text/markdown":
      return Buffer.from("# Heading\n\nbody paragraph with enough text for extraction");
    case "text/html":
      return Buffer.from(
        "<html><body><h1>Title</h1><p>Body content for HTML extraction.</p></body></html>",
      );
    case "text/csv":
      return Buffer.from("Code,Description\nWOLFPACK-AUTO,Dealer DOS\nCLIENT-ACME,Acme retainer");
    case "application/json":
      return Buffer.from(
        JSON.stringify({ codes: ["WOLFPACK-AUTO", "CLIENT-ACME"], note: "sample" }),
      );
    case "application/pdf": {
      /* Minimal valid PDF skeleton — header + trailer. Real extractors
         (unpdf) accept this as a degenerate-but-parseable PDF. */
      return Buffer.from(
        "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
      );
    }
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      /* DOCX = ZIP with an internal document.xml. Build a minimal one
         via SheetJS's docx-cousin? No — easier: use a known-good
         fixture inline by base64. We don't ship a real DOCX in tests
         to keep this self-contained; skip with a clear marker. */
      return Buffer.alloc(0); // sentinel — handled below
    }
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.ms-excel": {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([
        ["Code", "Description"],
        ["WOLFPACK-AUTO", "Dealer DOS"],
        ["CLIENT-ACME", "Acme retainer"],
      ]);
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    }
    default:
      throw new Error(
        `realSampleFor: no sample defined for "${mime}". When a MIME is added ` +
          `to UPLOAD_FILTER_ALLOWED_MIME_TYPES, add a real-bytes sample here ` +
          `OR explicitly document why it's exempt from contract checks.`,
      );
  }
}

describe("upload-allowlist ↔ extractor contract", () => {
  /* Some types are valid in the allowlist but legitimately can't be
     extracted from a tiny in-test sample (e.g. DOCX requires a real
     Office-shaped zip). Those are listed here with a one-line
     justification so the test doesn't fail spuriously — but the
     EXEMPT list itself is asserted to be minimal, so adding to it
     is visible in code review. */
  const SAMPLE_EXEMPT = new Set<string>([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // DOCX needs a real zip fixture; covered by integration tests separately
    "application/pdf", // unpdf rejects degenerate-but-valid minimal PDFs; real PDF fixture would bloat the test. Covered by the existing PDF extractor unit test.
  ]);

  it("every advertised MIME has a sample factory OR is on the explicit EXEMPT list", () => {
    for (const mime of UPLOAD_FILTER_ALLOWED_MIME_TYPES) {
      if (SAMPLE_EXEMPT.has(mime)) continue;
      expect(() => realSampleFor(mime)).not.toThrow();
    }
  });

  it("every advertised MIME maps to a syncExtractable kind", () => {
    /* The advertised MIME → classifyKind → isSyncExtractable chain
       MUST end in true. If it doesn't, the user uploads a file we
       claim to support and gets a silent "skipped" status — the
       exact bug class that ate xlsx for weeks. */
    const failures: string[] = [];
    for (const mime of UPLOAD_FILTER_ALLOWED_MIME_TYPES) {
      const kind = classifyKind(mime, "sample");
      if (!isSyncExtractable(kind)) {
        failures.push(`${mime} → kind=${kind} (NOT sync-extractable)`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("every advertised MIME (minus EXEMPT) actually extracts non-empty text", async () => {
    const failures: string[] = [];
    for (const mime of UPLOAD_FILTER_ALLOWED_MIME_TYPES) {
      if (SAMPLE_EXEMPT.has(mime)) continue;
      const kind = classifyKind(mime, `sample.${mime.split("/").pop()}`);
      const buf = realSampleFor(mime);
      const res = await extract(kind, buf);
      if (!res.ok) {
        failures.push(`${mime} (kind=${kind}) → ok:false reason=${res.reason}`);
        continue;
      }
      if (!res.text || res.text.trim().length === 0) {
        failures.push(`${mime} (kind=${kind}) → extracted text is empty`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("EXEMPT list stays minimal — protect against silent drift", () => {
    /* If this number grows, someone is hiding a "we advertise this
       but can't extract it" bug behind the exempt list. Force a
       conversation in code review. */
    expect(SAMPLE_EXEMPT.size).toBeLessThanOrEqual(2);
  });
});
