/**
 * Reading a PowerPoint deck.
 *
 * Measured on production 2026-08-27: 75 .pptx files in the Brain, none with a
 * single chunk. There was no pptx kind and no extractor, so they classified as
 * "other" and were skipped at ingest while the UI listed them as present. A
 * library of training decks was invisible to every question asked of it.
 *
 * The fixture below is a REAL zip built in the test, not a stubbed parser.
 * Everything asserted here is a way a deck actually breaks.
 */
import JSZip from "jszip";
import { pptxBufferToText, slideXmlToText } from "@/lib/brain/pptx";
import { classifyKind } from "@/lib/brain/types";
import { isSyncExtractable } from "@/lib/brain/extractor";

const wrap = (body: string) =>
  `<?xml version="1.0"?><p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
const para = (...runs: string[]) =>
  `<a:p>${runs.map((r) => `<a:t>${r}</a:t>`).join("")}</a:p>`;

async function deck(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  for (const [path, xml] of Object.entries(parts)) zip.file(path, xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("classification", () => {
  it.each([
    ["Training.pptx", ""],
    ["deck.PPTX", ""],
    ["", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ])("recognises %s as a deck", (filename, contentType) => {
    expect(classifyKind(contentType, filename)).toBe("pptx");
  });

  /* Classification alone is not enough. It was the missing SYNC_KINDS entry
     that left these skipped rather than extracted. */
  it("is extracted at ingest rather than deferred to a worker", () => {
    expect(isSyncExtractable("pptx")).toBe(true);
  });
});

describe("slide text", () => {
  /* PowerPoint splits a single word across runs whenever formatting changes
     mid-word, so joining runs with a space produces "Signature m oments". */
  it("joins runs within a paragraph without inserting spaces", () => {
    expect(slideXmlToText(wrap(para("Signature ", "moments")))).toBe("Signature moments");
  });

  it("keeps separate bullets on separate lines", () => {
    const out = slideXmlToText(wrap(para("First bullet") + para("Second bullet")));
    expect(out).toBe("First bullet\nSecond bullet");
  });

  it("decodes entities, ampersand last", () => {
    expect(slideXmlToText(wrap(para("Rolex &amp; Four Seasons")))).toBe("Rolex & Four Seasons");
    expect(slideXmlToText(wrap(para("&amp;lt; stays literal")))).toBe("&lt; stays literal");
  });

  it("drops empty paragraphs rather than emitting blank lines", () => {
    expect(slideXmlToText(wrap(para("Only line") + "<a:p></a:p>"))).toBe("Only line");
  });
});

describe("a whole deck", () => {
  /* Lexical sorting puts slide10 before slide2 and scrambles a deck whose
     entire meaning is its order. */
  it("orders slides numerically, not lexically", async () => {
    const buf = await deck({
      "ppt/slides/slide1.xml": wrap(para("One")),
      "ppt/slides/slide2.xml": wrap(para("Two")),
      "ppt/slides/slide10.xml": wrap(para("Ten")),
    });
    const text = await pptxBufferToText(buf);
    expect(text.indexOf("Slide 2")).toBeLessThan(text.indexOf("Slide 10"));
    expect(text.indexOf("Slide 1")).toBeLessThan(text.indexOf("Slide 2"));
  });

  /* A slide reads "Signature moments" in 40pt and the notes carry the
     paragraph explaining what that means. Indexing only the face retrieves
     the title and loses the substance. */
  it("includes speaker notes, labelled", async () => {
    const buf = await deck({
      "ppt/slides/slide1.xml": wrap(para("Signature moments")),
      "ppt/notesSlides/notesSlide1.xml": wrap(para("Collect feedback from the group")),
    });
    const text = await pptxBufferToText(buf);
    expect(text).toContain("Speaker notes: Collect feedback from the group");
  });

  it("matches notes to their own slide, not the first one", async () => {
    const buf = await deck({
      "ppt/slides/slide1.xml": wrap(para("First")),
      "ppt/slides/slide2.xml": wrap(para("Second")),
      "ppt/notesSlides/notesSlide2.xml": wrap(para("Belongs to two")),
    });
    const text = await pptxBufferToText(buf);
    const second = text.slice(text.indexOf("## Slide 2"));
    expect(second).toContain("Belongs to two");
    expect(text.slice(0, text.indexOf("## Slide 2"))).not.toContain("Belongs to two");
  });

  /* The heading is what lets a citation say where a sentence came from. */
  it("keeps slide numbers so a citation is checkable", async () => {
    const buf = await deck({ "ppt/slides/slide7.xml": wrap(para("Content")) });
    expect(await pptxBufferToText(buf)).toContain("## Slide 7");
  });

  it("skips slides that carry nothing", async () => {
    const buf = await deck({
      "ppt/slides/slide1.xml": wrap(para("Real content")),
      "ppt/slides/slide2.xml": wrap(""),
    });
    const text = await pptxBufferToText(buf);
    expect(text).toContain("## Slide 1");
    expect(text).not.toContain("## Slide 2");
  });

  /* An image-only deck has no text and needs OCR. That is a different fix
     from a parse error and must not be filed under the same reason. */
  it("returns empty for a deck with no text, rather than throwing", async () => {
    const buf = await deck({ "ppt/slides/slide1.xml": wrap("") });
    expect(await pptxBufferToText(buf)).toBe("");
  });

  it("refuses a file that is not a deck", async () => {
    const notADeck = await deck({ "word/document.xml": "<w:document/>" });
    await expect(pptxBufferToText(notADeck)).rejects.toThrow(/no slides/i);
  });
});
