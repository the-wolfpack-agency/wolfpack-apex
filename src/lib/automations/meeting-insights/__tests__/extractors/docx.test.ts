/**
 * .docx extractor tests — uses the hand-crafted fixture
 * `__fixtures__/sample.docx`. Generated as a tiny valid OOXML zip with
 * two paragraphs:
 *   "Meeting agenda for Q2 review."
 *   "Discuss roadmap and next steps."
 *
 * Tests:
 *   - real fixture extracts to expected text
 *   - corrupt bytes → status:"error", no throw
 *   - empty buffer → status:"error" (mammoth rejects)
 */
import { readFileSync } from "fs";
import { join } from "path";
import { extractDocx } from "../../extractors/docx";

const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "__fixtures__",
  "sample.docx",
);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("extractDocx", () => {
  test("extracts text from a real .docx fixture", async () => {
    const bytes = readFileSync(FIXTURE);
    const result = await extractDocx(bytes, DOCX_MIME, "sample.docx");
    expect(result.status).toBe("extracted");
    expect(result.text).toContain("Meeting agenda for Q2 review.");
    expect(result.text).toContain("Discuss roadmap and next steps.");
  });

  test("corrupt bytes → status:'error', text:null, no throw", async () => {
    const garbage = Buffer.from("not a docx at all, just random bytes");
    const result = await extractDocx(garbage, DOCX_MIME, "broken.docx");
    expect(result).toEqual({ text: null, status: "error" });
  });

  test("empty buffer → status:'error'", async () => {
    const result = await extractDocx(Buffer.alloc(0), DOCX_MIME, "empty.docx");
    expect(result.status).toBe("error");
    expect(result.text).toBeNull();
  });
});
