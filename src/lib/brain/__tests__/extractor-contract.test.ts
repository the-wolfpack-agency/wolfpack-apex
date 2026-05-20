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

import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import {
  UPLOAD_FILTER_ALLOWED_MIME_TYPES,
} from "@/lib/brain/upload-filter";
import { classifyKind, type BrainKind } from "@/lib/brain/types";
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

  /**
   * DB drift guard, shipped 2026-05-20 after the xlsx upload silently
   * returned "internal" for hours because `kind='xlsx'` violated the
   * brain_documents.kind CHECK constraint set in migration 028 — which
   * predated the BrainKind union ever growing 'xlsx'. The TS code, the
   * extractor, the upload filter, and the magic-byte gate all knew
   * about xlsx; only the DB constraint didn't. The route caught the
   * generic Postgres error and returned reasons=["internal"] with no
   * row in brain_documents and no useful chip in the widget.
   *
   * This test reads the actual migration files (not the DB — we want
   * to fail offline at PR time, not at runtime) and asserts:
   *   - The full TS BrainKind union appears in the latest CHECK
   *     constraint definition found in src/db/migrations/*.sql.
   *   - Adding a new kind to the TS union without a matching migration
   *     fails this test before deploy.
   */
  it("every BrainKind value is covered by the latest brain_documents.kind CHECK constraint migration", () => {
    /* The full TS union — kept in sync with src/lib/brain/types.ts.
       If you change the BrainKind type, also update this list AND
       ship a migration that expands brain_documents_kind_check. */
    const ALL_BRAIN_KINDS: BrainKind[] = [
      "pdf",
      "docx",
      "xlsx",
      "text",
      "markdown",
      "csv",
      "html",
      "audio",
      "video",
      "image",
      "email",
      "other",
    ];

    const migrationsDir = path.resolve(__dirname, "../../../db/migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
      .sort();

    /* Walk migrations newest-first to find the latest one that touches
       brain_documents_kind_check. Take the LAST occurrence of the
       CHECK definition in that file — migrations DROP then re-ADD, so
       the final definition is what's actually live. */
    let latestCheckDef: string | null = null;
    let latestMigration: string | null = null;
    for (const f of [...files].reverse()) {
      const body = fs.readFileSync(path.join(migrationsDir, f), "utf8");
      if (!/brain_documents_kind_check/.test(body)) continue;
      /* Grab the inner string of the latest CHECK(kind IN (...)) or
         CHECK(kind = ANY(ARRAY[...])) shape in this file. */
      const matchIn = [...body.matchAll(/CHECK\s*\(\s*kind\s+IN\s*\(([^)]+)\)/gi)];
      const matchAny = [...body.matchAll(/CHECK\s*\(\s*kind\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]+)\]/gi)];
      const inner =
        matchIn.length > 0
          ? matchIn[matchIn.length - 1][1]
          : matchAny.length > 0
            ? matchAny[matchAny.length - 1][1]
            : null;
      if (inner) {
        latestCheckDef = inner;
        latestMigration = f;
        break;
      }
    }

    if (latestCheckDef === null) {
      throw new Error(
        "no migration defines brain_documents_kind_check — original migration 028 must exist",
      );
    }

    const literals = latestCheckDef
      .split(",")
      .map((s) => s.trim().replace(/^'/, "").replace(/'(::text)?$/, "").trim())
      .filter((s) => s.length > 0);

    const missing = ALL_BRAIN_KINDS.filter((k) => !literals.includes(k));
    if (missing.length > 0) {
      throw new Error(
        `BrainKind values missing from latest CHECK constraint (${latestMigration}): ` +
          `${missing.join(", ")}. Ship a migration that expands brain_documents_kind_check.`,
      );
    }
    expect(missing).toEqual([]);
  });
});
