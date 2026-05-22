/**
 * Persistence-layer contract tests for document recognition.
 *
 * Mocks pg's pool indirectly by mocking @/lib/db. Asserts:
 *   - Inserts include every field on the happy path.
 *   - Null extraction / pii_blocked / error paths still write a row.
 *   - Reads return null cleanly when not found.
 *   - Workspace scoping is in every WHERE clause.
 *   - DB row -> RecognizedDocument mapping handles JSONB string +
 *     object shapes and tolerates null extractor.
 */

export {};

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));

import {
  insertRecognition,
  getRecognition,
  findRecentBySha,
  recordUserCorrection,
} from "../persistence";
import type {
  DocumentClassification,
  ExtractedDocument,
} from "../types";

const fullClassification: DocumentClassification = {
  type: "receipt",
  confidence: 0.97,
  alternates: [{ type: "invoice", confidence: 0.03 }],
  rationale: "store name + line items + total",
  model: "claude-3-5-haiku-vision",
  latencyMs: 412,
  costCents: 0.18,
};

const fullExtraction: ExtractedDocument = {
  extractor: "azure_prebuilt_receipt",
  model: "prebuilt-receipt",
  fields: [
    { name: "vendor", value: "Whole Foods", confidence: 0.99 },
    { name: "total", value: "42.18", confidence: 0.95 },
  ],
  rawText: "Whole Foods... TOTAL 42.18",
  latencyMs: 1820,
  costCents: 0,
};

const sampleRow = {
  id: "rec-1",
  workspace_id: "w-1",
  uploaded_by: "u-1",
  uploaded_at: "2026-05-22T12:00:00Z",
  source_filename: "receipt.pdf",
  source_mime: "application/pdf",
  source_bytes: 1234,
  source_sha256: "sha-abc",
  classified_type: "receipt",
  classification_confidence: "0.970",
  classification_alternates: JSON.stringify([{ type: "invoice", confidence: 0.03 }]),
  classification_rationale: "store name + line items + total",
  classifier_model: "claude-3-5-haiku-vision",
  classifier_latency_ms: 412,
  classifier_cost_cents: "0.1800",
  extractor_key: "azure_prebuilt_receipt",
  extractor_model: "prebuilt-receipt",
  extracted_fields: JSON.stringify([
    { name: "vendor", value: "Whole Foods", confidence: 0.99 },
    { name: "total", value: "42.18", confidence: 0.95 },
  ]),
  extracted_raw_text: "Whole Foods... TOTAL 42.18",
  extractor_latency_ms: 1820,
  extractor_cost_cents: "0.0000",
  pii_blocked: false,
  error_kind: null,
  error_message: null,
  user_corrected_type: null,
  user_corrected_at: null,
};

beforeEach(() => {
  jest.resetAllMocks();
});

/* ----------------------------- insert path ---------------------------- */

describe("insertRecognition", () => {
  it("writes every field on the happy path and returns the new id", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "rec-1" }] });
    const out = await insertRecognition({
      workspaceId: "w-1",
      uploadedBy: "u-1",
      source: { filename: "receipt.pdf", mime: "application/pdf", bytes: 1234, sha256: "sha-abc" },
      classification: fullClassification,
      extraction: fullExtraction,
      piiBlocked: false,
    });
    expect(out).toEqual({ id: "rec-1" });
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const args = mockWriteQuery.mock.calls[0];
    /* params at indices match the SQL placeholder positions. */
    const params = args[1] as unknown[];
    expect(params[0]).toBe("w-1");
    expect(params[1]).toBe("u-1");
    expect(params[2]).toBe("receipt.pdf");
    expect(params[3]).toBe("application/pdf");
    expect(params[4]).toBe(1234);
    expect(params[5]).toBe("sha-abc");
    expect(params[6]).toBe("receipt");
    expect(params[7]).toBe(0.97);
    expect(params[8]).toBe(JSON.stringify(fullClassification.alternates));
    expect(params[13]).toBe("azure_prebuilt_receipt"); // extractor_key
    expect(params[15]).toBe(JSON.stringify(fullExtraction.fields));
    expect(params[19]).toBe(false); // pii_blocked
    expect(params[20]).toBe(null); // error_kind
    /* expectRows enforcement so a silent drop surfaces. */
    expect(args[2]).toEqual({ expectRows: 1 });
  });

  it("writes nulls for the extractor columns when extraction is null", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "rec-2" }] });
    await insertRecognition({
      workspaceId: "w-1",
      uploadedBy: "u-1",
      source: { filename: "x.png", mime: "image/png", bytes: 100, sha256: "sha-x" },
      classification: { ...fullClassification, type: "unknown" },
      extraction: null,
      piiBlocked: false,
    });
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(params[13]).toBeNull(); // extractor_key
    expect(params[14]).toBeNull(); // extractor_model
    expect(params[15]).toBeNull(); // extracted_fields
    expect(params[16]).toBeNull(); // extracted_raw_text
    expect(params[17]).toBeNull(); // extractor_latency_ms
    expect(params[18]).toBeNull(); // extractor_cost_cents
  });

  it("stores pii_blocked=true with error_kind=pii_blocked", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "rec-3" }] });
    await insertRecognition({
      workspaceId: "w-1",
      uploadedBy: "u-1",
      source: { filename: "x.pdf", mime: "application/pdf", bytes: 200, sha256: "sha-pii" },
      classification: { ...fullClassification, type: "unknown", confidence: 0 },
      extraction: null,
      piiBlocked: true,
      errorKind: "pii_blocked",
      errorMessage: "blocked_by=pii_ssn",
    });
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(params[19]).toBe(true);
    expect(params[20]).toBe("pii_blocked");
    expect(params[21]).toBe("blocked_by=pii_ssn");
  });

  it("stores error fields on classifier/extractor failure", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "rec-4" }] });
    await insertRecognition({
      workspaceId: "w-1",
      uploadedBy: "u-1",
      source: { filename: "x.pdf", mime: "application/pdf", bytes: 200, sha256: "sha-err" },
      classification: fullClassification,
      extraction: null,
      piiBlocked: false,
      errorKind: "extractor_failed",
      errorMessage: "azure 502",
    });
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(params[19]).toBe(false);
    expect(params[20]).toBe("extractor_failed");
    expect(params[21]).toBe("azure 502");
  });
});

/* ------------------------------ read path ----------------------------- */

describe("getRecognition", () => {
  it("returns null when no row matches", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getRecognition("w-1", "missing");
    expect(out).toBeNull();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/workspace_id\s*=\s*\$1/);
    expect(mockQuery.mock.calls[0][1]).toEqual(["w-1", "missing"]);
  });

  it("maps a DB row to the RecognizedDocument shape", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] });
    const out = await getRecognition("w-1", "rec-1");
    expect(out).not.toBeNull();
    expect(out!.id).toBe("rec-1");
    expect(out!.workspaceId).toBe("w-1");
    expect(out!.classification.type).toBe("receipt");
    expect(out!.classification.confidence).toBe(0.97);
    expect(out!.classification.alternates).toEqual([{ type: "invoice", confidence: 0.03 }]);
    expect(out!.extraction).not.toBeNull();
    expect(out!.extraction!.extractor).toBe("azure_prebuilt_receipt");
    expect(out!.extraction!.fields).toHaveLength(2);
    expect(out!.sourceFile.sha256).toBe("sha-abc");
  });

  it("returns extraction=null when extractor_key is null", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...sampleRow,
        extractor_key: null,
        extractor_model: null,
        extracted_fields: null,
        extracted_raw_text: null,
        extractor_latency_ms: null,
        extractor_cost_cents: null,
      }],
    });
    const out = await getRecognition("w-1", "rec-1");
    expect(out!.extraction).toBeNull();
  });

  it("tolerates JSONB that comes back already-parsed (object, not string)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...sampleRow,
        classification_alternates: [{ type: "invoice", confidence: 0.03 }],
        extracted_fields: fullExtraction.fields,
      }],
    });
    const out = await getRecognition("w-1", "rec-1");
    expect(out!.classification.alternates).toEqual([{ type: "invoice", confidence: 0.03 }]);
    expect(out!.extraction!.fields).toHaveLength(2);
  });
});

describe("findRecentBySha", () => {
  it("returns null when no recent row matches", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await findRecentBySha("w-1", "sha-x", 24);
    expect(out).toBeNull();
    expect(mockQuery.mock.calls[0][1]).toEqual(["w-1", "sha-x", 24]);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/workspace_id\s*=\s*\$1/);
    expect(sql).toMatch(/source_sha256\s*=\s*\$2/);
  });

  it("returns the row when one exists in the window", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] });
    const out = await findRecentBySha("w-1", "sha-abc", 24);
    expect(out).not.toBeNull();
    expect(out!.id).toBe("rec-1");
  });
});

/* ---------------------------- correction path ------------------------- */

describe("recordUserCorrection", () => {
  it("UPDATEs the row and maps the result", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{
        ...sampleRow,
        user_corrected_type: "invoice",
        user_corrected_at: "2026-05-22T13:00:00Z",
      }],
    });
    const out = await recordUserCorrection({
      workspaceId: "w-1",
      id: "rec-1",
      correctedType: "invoice",
    });
    expect(out).not.toBeNull();
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE instinct_document_recognitions/);
    expect(sql).toMatch(/workspace_id\s*=\s*\$1/);
    expect(params).toEqual(["w-1", "rec-1", "invoice"]);
  });

  it("returns null when the row is not in the workspace", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const out = await recordUserCorrection({
      workspaceId: "w-1",
      id: "missing",
      correctedType: "invoice",
    });
    expect(out).toBeNull();
  });

  it("refuses an invalid corrected_type without hitting the DB", async () => {
    const out = await recordUserCorrection({
      workspaceId: "w-1",
      id: "rec-1",
      // @ts-expect-error — intentional bad type
      correctedType: "bogus",
    });
    expect(out).toBeNull();
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });
});

/* --------------------------- scoping audit ---------------------------- */

describe("workspace scoping", () => {
  it("getRecognition includes workspace_id in WHERE", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getRecognition("w-1", "x");
    expect(mockQuery.mock.calls[0][0]).toMatch(/workspace_id\s*=\s*\$1/);
  });

  it("findRecentBySha includes workspace_id in WHERE", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findRecentBySha("w-1", "x", 1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/workspace_id\s*=\s*\$1/);
  });

  it("recordUserCorrection includes workspace_id in WHERE", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    await recordUserCorrection({ workspaceId: "w-1", id: "x", correctedType: "receipt" });
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(/workspace_id\s*=\s*\$1/);
  });
});
