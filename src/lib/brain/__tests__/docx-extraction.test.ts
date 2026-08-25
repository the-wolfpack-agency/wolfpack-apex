/**
 * Word documents extract.
 *
 * THE BUG THIS CLOSES, three times over. package.json overrides
 * @xmldom/xmldom to 0.9.x for a high-severity advisory. mammoth declares
 * ^0.8.6, every published version still does, and 0.9 made the mimeType
 * argument required while mammoth's wrapper drops the one its caller passes.
 * Every .docx threw.
 *
 * src/lib/principles/parser.ts hit it and moved off mammoth. The
 * meeting-insights extractor hit it and adopted the same replacement. The
 * Brain never did, and the Brain is where a corporate document library lands:
 * 90 documents in production failed with the mimeType error, and docx is most
 * of what such a library is made of.
 *
 * Built from a real .docx rather than a mocked parser, because every version
 * of this bug lived inside the parser. A test that mocks it proves nothing.
 */
import JSZip from "jszip";
import { extract, classifyKind } from "../extractor";

/** A minimal but genuine OOXML package. */
async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("a Word document reaches the Brain as text", () => {
  it("is classified as docx by content type and by extension", () => {
    expect(classifyKind(DOCX_TYPE, "training.docx")).toBe("docx");
    expect(classifyKind("application/octet-stream", "training.docx")).toBe("docx");
  });

  it("extracts the words in it", async () => {
    const buf = await makeDocx([
      "Porsche Brand Ambassador training day three.",
      "Distribute the paper and art supplies.",
    ]);
    const res = await extract("docx", buf);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.detail);
    expect(res.text).toContain("Brand Ambassador training day three");
    expect(res.text).toContain("art supplies");
  });

  /* The exact production failure. If this string ever comes back, the docx
     path has been pointed at mammoth again. */
  it("never fails on a mimeType it was not given", async () => {
    const buf = await makeDocx(["Anything at all."]);
    const res = await extract("docx", buf);
    const detail = res.ok ? "" : res.detail ?? "";
    expect(detail).not.toMatch(/mimeType/i);
    expect(detail).not.toMatch(/DOMParser/i);
  });

  /* Corrupt input is a clean failure, not a thrown exception: a connector
     walking nine hundred files must not die on one bad zip. */
  it("reports a corrupt document instead of throwing", async () => {
    const res = await extract("docx", Buffer.from("this is not a zip"));
    expect(res.ok).toBe(false);
  });

  it("reports an empty document as empty rather than failed", async () => {
    const res = await extract("docx", await makeDocx([]));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.reason).toBe("empty");
  });
});
