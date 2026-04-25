/**
 * application/pdf extractor tests.
 *
 * Real fixture bytes (`__fixtures__/sample.pdf`) are loaded; we exercise
 * the extractor's wrapping logic with an injected reader so the test
 * runs cleanly under ts-jest's CommonJS context (unpdf relies on a
 * dynamic ESM import that requires --experimental-vm-modules — see
 * `src/lib/brain/__tests__/extractor.test.ts` for the same pattern).
 *
 * The default `extractPdf` export uses unpdf and is verified end-to-end
 * by the next-build pipeline + the runtime route tests.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { extractPdf, makeExtractPdfWith } from "../../extractors/pdf";

const FIXTURE = join(__dirname, "..", "..", "__fixtures__", "sample.pdf");

describe("extractPdf — wrapping behavior (with injected reader)", () => {
  test("extracted: reader returns text for the real fixture bytes", async () => {
    const bytes = readFileSync(FIXTURE);
    const stub = makeExtractPdfWith(async (b) => {
      // Confirm we received the real fixture bytes (PDF magic).
      expect(b.subarray(0, 4).toString()).toBe("%PDF");
      return "Meeting notes from Q2.";
    });
    const result = await stub(bytes, "application/pdf", "sample.pdf");
    expect(result).toEqual({
      text: "Meeting notes from Q2.",
      status: "extracted",
    });
  });

  test("error: reader throws → status:'error', text:null, no throw", async () => {
    const stub = makeExtractPdfWith(async () => {
      throw new Error("malformed PDF");
    });
    const result = await stub(
      Buffer.from("not a pdf"),
      "application/pdf",
      "x.pdf",
    );
    expect(result).toEqual({ text: null, status: "error" });
  });

  test("extracted: reader returns empty string (image-only / scanned PDF)", async () => {
    const stub = makeExtractPdfWith(async () => "");
    const result = await stub(
      Buffer.alloc(0),
      "application/pdf",
      "empty.pdf",
    );
    expect(result).toEqual({ text: "", status: "extracted" });
  });
});

describe("extractPdf — default export contract", () => {
  test("default export is a function (AttachmentExtractor)", () => {
    expect(typeof extractPdf).toBe("function");
  });

  test("default export catches non-PDF bytes without throwing", async () => {
    const result = await extractPdf(
      Buffer.from("plainly not a pdf"),
      "application/pdf",
      "broken.pdf",
    );
    // Whether unpdf is loadable in this test environment or not, the
    // wrapping contract is the same: never throw, always return a typed
    // result.
    expect(["error", "extracted"]).toContain(result.status);
    if (result.status === "error") expect(result.text).toBeNull();
  });
});
