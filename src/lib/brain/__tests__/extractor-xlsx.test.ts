/**
 * Tests for xlsx extraction in the brain extractor pipeline.
 *
 * Covers:
 *   - classifyKind: xlsx + xls extensions, both Office MIME flavors
 *   - extractor: real xlsx buffer (built in-memory via SheetJS) → text
 *   - extractor: every sheet appears in output, each prefixed with its name
 *   - extractor: empty sheets dropped, but a workbook with at least one
 *     non-empty sheet still succeeds
 *   - extractor: garbage buffer → graceful failed result, not a throw
 *   - isSyncExtractable returns true for xlsx
 *   - upload-filter ALLOWED_MIME_TYPES includes both Office MIME flavors
 */

import * as XLSX from "xlsx";
import { classifyKind } from "@/lib/brain/types";
import { extract, isSyncExtractable } from "@/lib/brain/extractor";
import { UPLOAD_FILTER_ALLOWED_MIME_TYPES } from "@/lib/brain/upload-filter";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLS_MIME = "application/vnd.ms-excel";

function makeWorkbook(sheets: Array<{ name: string; rows: Array<Array<string | number>> }>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("classifyKind: xlsx", () => {
  it("recognises both MIME flavors", () => {
    expect(classifyKind(XLSX_MIME, "anything")).toBe("xlsx");
    expect(classifyKind(XLS_MIME, "anything")).toBe("xlsx");
  });
  it("recognises .xlsx and .xls extensions when MIME is generic", () => {
    expect(classifyKind("application/octet-stream", "Codes.xlsx")).toBe("xlsx");
    expect(classifyKind("application/octet-stream", "old.xls")).toBe("xlsx");
  });
});

describe("isSyncExtractable", () => {
  it("includes xlsx in the sync-extractable set", () => {
    expect(isSyncExtractable("xlsx")).toBe(true);
  });
});

describe("upload-filter allowlist", () => {
  it("includes both Office spreadsheet MIME types", () => {
    expect(UPLOAD_FILTER_ALLOWED_MIME_TYPES).toContain(XLSX_MIME);
    expect(UPLOAD_FILTER_ALLOWED_MIME_TYPES).toContain(XLS_MIME);
  });
});

describe("extract(xlsx)", () => {
  it("extracts every non-empty sheet with a name header", async () => {
    const buf = makeWorkbook([
      {
        name: "Job Codes",
        rows: [
          ["Code", "Description"],
          ["WOLFPACK-AUTO", "Dealer DOS work"],
          ["CLIENT-ACME", "Acme retainer"],
        ],
      },
      {
        name: "Notes",
        rows: [
          ["Note"],
          ["Codes refreshed quarterly"],
        ],
      },
    ]);
    const res = await extract("xlsx", buf);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("Sheet: Job Codes");
    expect(res.text).toContain("WOLFPACK-AUTO");
    expect(res.text).toContain("Acme retainer");
    expect(res.text).toContain("Sheet: Notes");
    expect(res.text).toContain("Codes refreshed quarterly");
  });

  it("skips empty sheets but keeps the workbook valid if at least one sheet has content", async () => {
    const buf = makeWorkbook([
      { name: "Empty", rows: [] },
      { name: "Real", rows: [["A"], ["one"]] },
    ]);
    const res = await extract("xlsx", buf);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("Sheet: Real");
    expect(res.text).not.toContain("Sheet: Empty");
  });

  it("returns ok:false reason=empty when no sheet has content", async () => {
    const buf = makeWorkbook([{ name: "Empty", rows: [] }]);
    const res = await extract("xlsx", buf);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("empty");
  });

  it("never throws on malformed input — returns a typed result", async () => {
    /* SheetJS is tolerant and will happily parse a string-like
       buffer as a single-cell sheet. The promise here is just that
       the extractor never throws to the caller — typed result either
       way. The magic-byte gate (security.ts) is what blocks junk
       BEFORE this function sees it. */
    const malformed = Buffer.from([0xFF, 0xFE, 0x00, 0x00, 0x00, 0x00]);
    const res = await extract("xlsx", malformed);
    expect(typeof res.ok).toBe("boolean");
  });
});
