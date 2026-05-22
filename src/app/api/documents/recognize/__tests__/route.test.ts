/**
 * Contract tests for POST /api/documents/recognize.
 *
 * Covers:
 *   - Feature flag gate (503 when DOCUMENT_RECOGNITION_ENABLED unset).
 *   - Auth (401 when requireCapability denies).
 *   - Multipart validation (400/413/415).
 *   - PII pre-scan blocks vendor call but still persists.
 *   - Dedup short-circuits classifier + extractor.
 *   - Happy paths for every document type.
 *   - Classifier failure -> 502 + persisted row.
 *   - Extractor failure -> 200 with warning + persisted row.
 *   - trackEvent invoked with the contract metadata.
 *   - Workspace scoping passed through to the persistence layer.
 */

export {};

const mockRequireCapability = jest.fn();
const mockPreScan = jest.fn();
const mockClassify = jest.fn();
const mockExtract = jest.fn();
const mockInsertRecognition = jest.fn();
const mockGetRecognition = jest.fn();
const mockFindRecentBySha = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/azure/pre-scan", () => ({
  preScanForBlockingPII: (...a: unknown[]) => mockPreScan(...a),
}));
jest.mock("@/lib/document-recognition/classifier", () => ({
  classifyDocument: (...a: unknown[]) => mockClassify(...a),
}));
jest.mock("@/lib/document-recognition/router", () => ({
  extractDocument: (...a: unknown[]) => mockExtract(...a),
}));
jest.mock("@/lib/document-recognition/persistence", () => ({
  insertRecognition: (...a: unknown[]) => mockInsertRecognition(...a),
  getRecognition: (...a: unknown[]) => mockGetRecognition(...a),
  findRecentBySha: (...a: unknown[]) => mockFindRecentBySha(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";

/* Pull route after mocks are wired so the module imports resolve to
   the jest-mock versions. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require("../route");

const okAuth = (over: { id?: string; role?: string; workspaceId?: string } = {}) => ({
  ok: true,
  user: {
    id: over.id ?? "u-1",
    role: over.role ?? "cto",
    workspaceId: over.workspaceId ?? "w-1",
    email: "homyk@thewolfpack.agency",
  },
  capabilities: new Set(),
});

const baseClassification = (type = "receipt") => ({
  type,
  confidence: 0.93,
  alternates: [],
  rationale: "looks like a " + type,
  model: "claude-3-5-haiku-vision",
  latencyMs: 380,
  costCents: 0.15,
});

const baseExtraction = (extractor = "azure_prebuilt_receipt") => ({
  extractor,
  model: "prebuilt-receipt",
  fields: [{ name: "vendor", value: "Acme", confidence: 0.97 }],
  rawText: "Acme line 1\nTotal 10",
  latencyMs: 1500,
  costCents: 0,
});

const baseRecognition = (over: Record<string, unknown> = {}) => ({
  id: "rec-1",
  workspaceId: "w-1",
  userId: "u-1",
  sourceFile: { filename: "x.png", mime: "image/png", bytes: 3, sha256: "sha-test" },
  classification: baseClassification(),
  extraction: baseExtraction(),
  piiBlocked: false,
  recognizedAt: "2026-05-22T12:00:00Z",
  ...over,
});

function multipartReq(file: File | null, path = "/api/documents/recognize"): NextRequest {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new NextRequest(`https://x.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: fd,
  });
}

const ORIG_FLAG = process.env.DOCUMENT_RECOGNITION_ENABLED;

beforeEach(() => {
  jest.resetAllMocks();
  process.env.DOCUMENT_RECOGNITION_ENABLED = "true";
  mockPreScan.mockReturnValue({ ok: true, blockedBy: [] });
  mockFindRecentBySha.mockResolvedValue(null);
  mockInsertRecognition.mockResolvedValue({ id: "rec-1" });
  mockGetRecognition.mockResolvedValue(baseRecognition());
  mockTrackEvent.mockReturnValue(undefined);
});

afterAll(() => {
  if (ORIG_FLAG === undefined) delete process.env.DOCUMENT_RECOGNITION_ENABLED;
  else process.env.DOCUMENT_RECOGNITION_ENABLED = ORIG_FLAG;
});

/* ----------------------------- feature flag --------------------------- */

describe("feature flag", () => {
  it("503 when DOCUMENT_RECOGNITION_ENABLED is unset", async () => {
    delete process.env.DOCUMENT_RECOGNITION_ENABLED;
    const f = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("feature_disabled");
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  it("503 when DOCUMENT_RECOGNITION_ENABLED=false", async () => {
    process.env.DOCUMENT_RECOGNITION_ENABLED = "false";
    const f = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(503);
  });
});

/* -------------------------------- auth -------------------------------- */

describe("auth", () => {
  it("401 when requireCapability denies", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const f = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(401);
    expect(mockClassify).not.toHaveBeenCalled();
  });
});

/* ----------------------------- input checks --------------------------- */

describe("input validation", () => {
  it("400 when file is missing", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const res = await POST(multipartReq(null));
    expect(res.status).toBe(400);
  });

  it("415 when MIME unsupported", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const f = new File([new Uint8Array([1])], "x.txt", { type: "text/plain" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(415);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("413 when file exceeds MAX_DOCUMENT_BYTES", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const big = new Uint8Array(4 * 1024 * 1024); // > 3.5 MiB
    const f = new File([big], "big.png", { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(413);
    expect(mockClassify).not.toHaveBeenCalled();
  });
});

/* ----------------------------- happy paths ---------------------------- */

describe.each([
  ["receipt", "azure_prebuilt_receipt"],
  ["invoice", "azure_prebuilt_invoice"],
  ["tax_w2", "azure_prebuilt_tax_us_w2"],
  ["tax_1099", "azure_prebuilt_tax_us_1099"],
  ["id_document", "azure_prebuilt_id_document"],
])("happy path: %s", (type, extractor) => {
  it(`classifies + extracts + persists + responds`, async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockClassify.mockResolvedValueOnce(baseClassification(type));
    mockExtract.mockResolvedValueOnce(baseExtraction(extractor));
    mockGetRecognition.mockResolvedValueOnce(
      baseRecognition({
        classification: baseClassification(type),
        extraction: baseExtraction(extractor),
      }),
    );
    const f = new File([new Uint8Array([1, 2, 3])], `${type}.png`, { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.from_cache).toBe(false);
    expect(body.piiBlocked).toBe(false);
    expect(body.recognition.classification.type).toBe(type);
    expect(body.recognition.extraction.extractor).toBe(extractor);
    expect(mockInsertRecognition).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.document_recognized",
      "u-1",
      "cto",
      expect.objectContaining({
        recognition_id: "rec-1",
        classified_type: type,
        extractor_key: extractor,
        success: true,
        pii_blocked: false,
      }),
    );
  });
});

/* ---------------------------- unknown type --------------------------- */

describe("unknown document type", () => {
  it("persists row with extraction=null and returns 200", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockClassify.mockResolvedValueOnce(baseClassification("unknown"));
    mockGetRecognition.mockResolvedValueOnce(
      baseRecognition({
        classification: baseClassification("unknown"),
        extraction: null,
      }),
    );
    const f = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recognition.extraction).toBeNull();
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.document_recognized",
      "u-1",
      "cto",
      expect.objectContaining({
        classified_type: "unknown",
        extractor_key: "none",
        success: false,
      }),
    );
  });
});

/* ----------------------------- PII blocked --------------------------- */

describe("PII pre-scan", () => {
  it("blocks vendor calls, persists pii_blocked row, returns 200 with piiBlocked=true", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockPreScan.mockReturnValueOnce({ ok: false, blockedBy: ["pii_ssn"] });
    mockGetRecognition.mockResolvedValueOnce(
      baseRecognition({
        classification: { ...baseClassification("unknown"), confidence: 0 },
        extraction: null,
        piiBlocked: true,
      }),
    );
    const f = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.piiBlocked).toBe(true);
    expect(body.recognition.extraction).toBeNull();
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockInsertRecognition).toHaveBeenCalledWith(
      expect.objectContaining({
        piiBlocked: true,
        errorKind: "pii_blocked",
      }),
    );
  });
});

/* --------------------------- classifier fail ------------------------- */

describe("classifier failure", () => {
  it("persists a row with error_kind, returns 502", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockClassify.mockRejectedValueOnce(new Error("anthropic 502"));
    const f = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("classifier_failed");
    expect(mockInsertRecognition).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "classifier_failed" }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.document_recognized",
      "u-1",
      "cto",
      expect.objectContaining({ error_kind: "classifier_failed", success: false }),
    );
  });
});

/* --------------------------- extractor fail -------------------------- */

describe("extractor failure", () => {
  it("persists classification + error, returns 200 with warning", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockClassify.mockResolvedValueOnce(baseClassification("receipt"));
    mockExtract.mockRejectedValueOnce(new Error("azure 503"));
    mockGetRecognition.mockResolvedValueOnce(
      baseRecognition({
        classification: baseClassification("receipt"),
        extraction: null,
      }),
    );
    const f = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recognition.extraction).toBeNull();
    expect(body.warning).toMatch(/extractor_failed/);
    expect(mockInsertRecognition).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "extractor_failed" }),
    );
  });
});

/* ------------------------------ dedup -------------------------------- */

describe("dedup", () => {
  it("returns from_cache=true and skips classifier+extractor when SHA matches", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindRecentBySha.mockResolvedValueOnce(baseRecognition({ id: "rec-existing" }));
    const f = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    const res = await POST(multipartReq(f));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from_cache).toBe(true);
    expect(body.recognition.id).toBe("rec-existing");
    expect(mockClassify).not.toHaveBeenCalled();
    expect(mockExtract).not.toHaveBeenCalled();
    expect(mockInsertRecognition).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.document_recognized",
      "u-1",
      "cto",
      expect.objectContaining({ cached: true }),
    );
  });
});

/* ------------------------ workspace scoping -------------------------- */

describe("workspace scoping", () => {
  it("passes the auth workspaceId into findRecentBySha + insertRecognition", async () => {
    mockRequireCapability.mockResolvedValue(okAuth({ workspaceId: "w-7" }));
    mockClassify.mockResolvedValueOnce(baseClassification("receipt"));
    mockExtract.mockResolvedValueOnce(baseExtraction());
    mockGetRecognition.mockResolvedValueOnce(baseRecognition({ workspaceId: "w-7" }));
    const f = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    await POST(multipartReq(f));
    expect(mockFindRecentBySha).toHaveBeenCalledWith("w-7", expect.any(String), expect.any(Number));
    expect(mockInsertRecognition).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w-7" }),
    );
  });
});

/* ---------------------------- analytics ------------------------------ */

describe("analytics", () => {
  it("trackEvent receives the full metadata shape on success", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockClassify.mockResolvedValueOnce(baseClassification("receipt"));
    mockExtract.mockResolvedValueOnce(baseExtraction());
    mockGetRecognition.mockResolvedValueOnce(baseRecognition());
    const f = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    await POST(multipartReq(f));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.document_recognized",
      "u-1",
      "cto",
      expect.objectContaining({
        recognition_id: expect.any(String),
        classified_type: "receipt",
        classification_confidence: expect.any(Number),
        extractor_key: "azure_prebuilt_receipt",
        success: true,
        pii_blocked: false,
        classifier_latency_ms: expect.any(Number),
        extractor_latency_ms: expect.any(Number),
        total_cost_cents: expect.any(Number),
      }),
    );
  });
});
