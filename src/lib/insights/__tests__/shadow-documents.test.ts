/**
 * Documents the business circulated that the knowledge base has never seen.
 *
 * Every filename here is a real row from instinct_meeting_attachments on
 * 2026-08-31, including the six that made the furniture rule necessary.
 */
import {
  isLikelyDocument,
  findShadowDocuments,
  describeShadow,
  MIN_DOCUMENT_BYTES,
  type CirculatedFile,
} from "../shadow-documents";

const f = (filename: string, mime: string | null = "application/pdf", sizeBytes = 200_000): CirculatedFile => ({
  filename,
  mime,
  sizeBytes,
});

const nothingIndexed = new Set<string>();

describe("what is a document and what is part of the message", () => {
  /* SIX OF THE FIRST TWELVE FINDINGS. Reporting a signature logo as an
     uningested business document is how a report gets skimmed and closed. */
  it("excludes the images inside email signatures", () => {
    for (const n of ["image001.gif", "image002.gif", "image006.gif", "image010.png"]) {
      expect(isLikelyDocument(f(n, "image/gif", 4_000))).toBe(false);
    }
  });

  it("excludes a calendar part, which describes the meeting rather than coming from it", () => {
    expect(isLikelyDocument(f("invite.ics", "text/calendar"))).toBe(false);
  });

  it("keeps the real documents that circulated", () => {
    for (const n of [
      "100 Cars Nobu to NPB.pdf",
      "Brand Ambassador PreComm Videos.xlsx",
      "coreyb 4.20.26.xlsx",
      "Fuerst 2.pdf",
    ]) {
      expect(isLikelyDocument(f(n))).toBe(true);
    }
  });

  /* A scan or a screenshot somebody meant to share is a document, so size
     decides rather than type. */
  it("keeps a large image, because it may be a scan somebody shared", () => {
    expect(isLikelyDocument(f("scanned-memo.png", "image/png", MIN_DOCUMENT_BYTES + 1))).toBe(true);
    expect(isLikelyDocument(f("tiny-icon.png", "image/png", 900))).toBe(false);
  });

  /* A rule to drop html email bodies was written and immediately dropped
     CFTR_Design_Brief.html, a real design brief. The two are not reliably
     distinguishable by name, so html stays in: a false positive costs a
     second to dismiss, and a design brief deleted by a clever rule is never
     seen again. */
  it("keeps html rather than risk deleting a document saved as one", () => {
    expect(isLikelyDocument(f("CFTR_Design_Brief.html", "text/html"))).toBe(true);
    expect(isLikelyDocument(f("aidan_mulready (1).html", "text/html"))).toBe(true);
  });
});

describe("what the knowledge base has never seen", () => {
  it("finds a circulated document that was never indexed", () => {
    const r = findShadowDocuments([f("CFTR_Design_Brief.html", "text/html")], nothingIndexed);
    expect(r.shadow.map((s) => s.filename)).toEqual(["CFTR_Design_Brief.html"]);
    expect(r.shadow[0].because).toMatch(/no answer can cite it/);
  });

  it("says nothing about one already indexed", () => {
    const r = findShadowDocuments([f("Fuerst 2.pdf")], new Set(["fuerst 2.pdf"]));
    expect(r.shadow).toEqual([]);
    expect(r.known).toHaveLength(1);
  });

  /* The same document arrives as a pdf in one place and a docx in another and
     it is the same document. */
  it("matches across a changed extension", () => {
    const r = findShadowDocuments([f("Design Brief.docx")], new Set(["design brief.pdf"]));
    expect(r.shadow).toEqual([]);
  });

  it("counts a file once however many meetings carried it", () => {
    const r = findShadowDocuments([f("Fuerst 2.pdf"), f("fuerst 2.pdf")], nothingIndexed);
    expect(r.shadow).toHaveLength(1);
  });

  it("separates the furniture rather than dropping it silently", () => {
    const r = findShadowDocuments([f("image001.gif", "image/gif", 4_000), f("Real.pdf")], nothingIndexed);
    expect(r.shadow.map((s) => s.filename)).toEqual(["Real.pdf"]);
    expect(r.furniture).toHaveLength(1);
  });
});

describe("what it refuses to claim", () => {
  /* The stronger claim is tempting and would have a client hunting for a
     document that is exactly where it should be. */
  it("does not say the document is missing from SharePoint", () => {
    const text = describeShadow(findShadowDocuments([f("Real.pdf")], nothingIndexed));
    expect(text).toMatch(/does NOT mean they are missing from SharePoint/i);
    expect(text).toMatch(/different fix/i);
  });

  /* A document indexed under another name reads as missing, so this is a list
     to check rather than a list of failures. */
  it("says the matching is by name and therefore approximate", () => {
    const text = describeShadow(findShadowDocuments([f("Real.pdf")], nothingIndexed));
    expect(text).toMatch(/Matched by filename/i);
    expect(text).toMatch(/list to check/i);
  });

  it("says so plainly when there was nothing to compare", () => {
    expect(describeShadow(findShadowDocuments([], nothingIndexed))).toMatch(/No circulated files/);
  });
});
