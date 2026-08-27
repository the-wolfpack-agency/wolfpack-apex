/**
 * The docx extractor, against a REAL .docx, because that is the shape reality
 * produces and the mock never was.
 *
 * WHY THIS FIXTURE IS A GENUINE OOXML ZIP. Ninety Word documents, which is
 * every single .docx in the Brain, have sat at status=failed since June with
 * `DOMParser.parseFromString: the provided mimeType "undefined" is not valid`.
 * The parser was fixed in #402 on 2026-08-25 and the corpus was never
 * reprocessed, so the fix has still never touched a real document.
 *
 * That is the recurring failure in this codebase stated exactly: a control
 * declared, described accurately, and never executed against the input it
 * exists for. The credential detector had sixteen passing tests while four of
 * its seven branches could not match, because every test used the JavaScript
 * shape the code handled. A docx test built from a mocked parser would prove
 * the same nothing.
 *
 * So the fixture is a zip with [Content_Types].xml, _rels/.rels and
 * word/document.xml, containing headings, bold runs and split runs, which is
 * what Word actually emits. If the extractor regresses, this fails here rather
 * than being discovered by a client asking what their SOW says.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyKind, extract, isSyncExtractable } from "../extractor";

const FIXTURE = join(__dirname, "fixtures", "statement-of-work.docx");
const DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function bytes(): Buffer {
  return readFileSync(FIXTURE);
}

describe("a real Word document", () => {
  it("is a genuine OOXML zip, not a stub", () => {
    /* PK\\x03\\x04. If somebody replaces the fixture with a text file, every
       assertion below would still pass against a parser that had regressed. */
    const b = bytes();
    expect(b.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(b.length).toBeGreaterThan(500);
  });

  it("classifies as docx from the content type and from the filename alone", () => {
    expect(classifyKind(DOCX_CT, "statement-of-work.docx")).toBe("docx");
    /* SharePoint does not always send a content type, and the filename is the
       only signal left when it does not. */
    expect(classifyKind("application/octet-stream", "statement-of-work.docx")).toBe("docx");
    expect(classifyKind(undefined as never, "statement-of-work.docx")).toBe("docx");
  });

  it("is extractable synchronously, so a sync ingest must not skip it", () => {
    expect(isSyncExtractable("docx")).toBe(true);
  });

  it("extracts the text, which is the whole point and has never happened in production", async () => {
    const res = await extract("docx", bytes());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("Statement of Work");
    expect(res.text).toContain("Payment terms are net thirty days");
  });

  it("joins runs that Word split mid-sentence", async () => {
    /* Word breaks a sentence into separate runs whenever formatting changes.
       An extractor that emits runs verbatim produces "Phase" and "One" as
       separate tokens and the sentence never matches a search for it. */
    const res = await extract("docx", bytes());
    if (!res.ok) return;
    const flat = res.text.replace(/\s+/g, " ");
    expect(flat).toContain("The engagement covers");
    expect(flat).toContain("Phase One");
    expect(flat).toContain("delivery");
  });

  it("does not throw the mimeType error that failed all ninety documents", async () => {
    const res = await extract("docx", bytes());
    const detail = res.ok ? "" : (res.detail ?? "");
    expect(detail).not.toMatch(/mimeType/i);
    expect(detail).not.toMatch(/DOMParser/i);
  });

  it("produces enough text to chunk, so a success is not an empty success", async () => {
    /* A document that extracts to nothing lands indexed with zero chunks and
       is quoted by nobody, which reads as a pass and is not one. */
    const res = await extract("docx", bytes());
    if (!res.ok) return;
    expect(res.text.trim().length).toBeGreaterThan(60);
  });
});

describe("failure is still reported honestly", () => {
  it("a corrupt docx fails rather than silently extracting nothing", async () => {
    const res = await extract("docx", Buffer.from("PK\x03\x04 not really a docx"));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    /* Named, so the reprocess can tell a fixable parser bug from a genuinely
       broken file and does not retry the same corruption forever. */
    expect(res.detail).toBeTruthy();
  });
});
