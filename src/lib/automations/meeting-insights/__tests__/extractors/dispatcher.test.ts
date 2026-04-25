/**
 * Attachment extractor dispatcher (extractors/index.ts) tests.
 *
 * Ensures every supported MIME routes to the right extractor and that
 * unsupported MIMEs / extractor exceptions return the correct typed
 * status without throwing.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  extractAttachmentText,
  isSupportedMime,
} from "../../extractors";

const DOCX_FIXTURE = join(__dirname, "..", "..", "__fixtures__", "sample.docx");
const PDF_FIXTURE = join(__dirname, "..", "..", "__fixtures__", "sample.pdf");

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("extractAttachmentText dispatcher", () => {
  test("text/plain → extracted via text extractor", async () => {
    const result = await extractAttachmentText(
      Buffer.from("hello"),
      "text/plain",
      "x.txt",
    );
    expect(result).toEqual({ text: "hello", status: "extracted" });
  });

  test("text/markdown → extracted via text extractor", async () => {
    const result = await extractAttachmentText(
      Buffer.from("# heading"),
      "text/markdown",
      "x.md",
    );
    expect(result).toEqual({ text: "# heading", status: "extracted" });
  });

  test("text/csv → extracted via text extractor", async () => {
    const result = await extractAttachmentText(
      Buffer.from("a,b\n1,2"),
      "text/csv",
      "x.csv",
    );
    expect(result.status).toBe("extracted");
    expect(result.text).toBe("a,b\n1,2");
  });

  test("application/pdf → routes to PDF extractor (real fixture, unpdf may not load in jest CommonJS — accept extracted OR error)", async () => {
    // The PDF extractor's contract is fully covered by pdf.test.ts
    // (with an injected reader). Here we only verify dispatcher routing:
    // the extractor must run, and must NEVER fall through to
    // 'unsupported_mime'. unpdf's dynamic ESM import may or may not
    // resolve depending on the jest invocation flags; both the
    // 'extracted' and 'error' branches are valid evidence of routing.
    const bytes = readFileSync(PDF_FIXTURE);
    const result = await extractAttachmentText(
      bytes,
      "application/pdf",
      "sample.pdf",
    );
    expect(["extracted", "error"]).toContain(result.status);
    expect(result.status).not.toBe("unsupported_mime");
  });

  test("application/.../wordprocessingml.document → extracted via DOCX extractor", async () => {
    const bytes = readFileSync(DOCX_FIXTURE);
    const result = await extractAttachmentText(bytes, DOCX_MIME, "sample.docx");
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("Meeting agenda");
  });

  test("text/html → extracted via HTML extractor", async () => {
    const result = await extractAttachmentText(
      Buffer.from("<p>hi</p>"),
      "text/html",
      "x.html",
    );
    expect(result.status).toBe("extracted");
    expect(result.text).toBe("hi");
  });

  test("MIME with charset suffix is normalized: 'text/plain; charset=utf-8'", async () => {
    const result = await extractAttachmentText(
      Buffer.from("ok"),
      "text/plain; charset=utf-8",
      "x.txt",
    );
    expect(result.status).toBe("extracted");
    expect(result.text).toBe("ok");
  });

  test("MIME case-insensitive: 'TEXT/PLAIN'", async () => {
    const result = await extractAttachmentText(
      Buffer.from("ok"),
      "TEXT/PLAIN",
      "x.txt",
    );
    expect(result.status).toBe("extracted");
  });

  test("unsupported MIME → status:'unsupported_mime', text:null", async () => {
    const result = await extractAttachmentText(
      Buffer.from("\xFF\xD8"), // jpeg magic
      "image/jpeg",
      "img.jpg",
    );
    expect(result).toEqual({ text: null, status: "unsupported_mime" });
  });

  test("audio/mp3 → unsupported_mime (no extractor)", async () => {
    const result = await extractAttachmentText(
      Buffer.from(""),
      "audio/mpeg",
      "talk.mp3",
    );
    expect(result.status).toBe("unsupported_mime");
  });

  test("corrupt PDF bytes → status:'error', no throw", async () => {
    const result = await extractAttachmentText(
      Buffer.from("not a pdf"),
      "application/pdf",
      "broken.pdf",
    );
    expect(result.status).toBe("error");
    expect(result.text).toBeNull();
  });

  test("empty MIME → unsupported_mime", async () => {
    const result = await extractAttachmentText(
      Buffer.from("anything"),
      "",
      "x",
    );
    expect(result.status).toBe("unsupported_mime");
  });
});

describe("isSupportedMime", () => {
  test.each([
    ["text/plain", true],
    ["text/markdown", true],
    ["text/csv", true],
    ["text/html", true],
    ["application/pdf", true],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      true,
    ],
    ["TEXT/PLAIN", true],
    ["text/plain; charset=utf-8", true],
    ["image/jpeg", false],
    ["audio/mpeg", false],
    ["application/octet-stream", false],
    ["", false],
  ])("isSupportedMime(%s) === %s", (mime, expected) => {
    expect(isSupportedMime(mime)).toBe(expected);
  });
});
