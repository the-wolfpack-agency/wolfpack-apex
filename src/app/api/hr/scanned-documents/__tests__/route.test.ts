/**
 * Contract tests for /api/hr/scanned-documents.
 * Pins: capability gates, employee + doc-type validation, ID-doc vs
 * OCR routing, PII pre-scan refusal, dedup, error mapping.
 */

export {};

const mockRequire = jest.fn();
const mockScanId = jest.fn();
const mockOcr = jest.fn();
const mockIsFormRec = jest.fn();
const mockIsVision = jest.fn();
const mockFind = jest.fn();
const mockInsert = jest.fn();
const mockList = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequire(...a),
}));
jest.mock("@/lib/azure/form-recognizer", () => ({
  scanIdDocument: (...a: unknown[]) => mockScanId(...a),
  isFormRecognizerConfigured: () => mockIsFormRec(),
  RECEIPT_MAX_BYTES: 3.5 * 1024 * 1024,
}));
jest.mock("@/lib/azure/vision-ocr", () => ({
  ocrImage: (...a: unknown[]) => mockOcr(...a),
  isVisionConfigured: () => mockIsVision(),
}));
jest.mock("@/lib/hr/scanned-documents", () => ({
  findHrDocBySha: (...a: unknown[]) => mockFind(...a),
  insertHrDoc: (...a: unknown[]) => mockInsert(...a),
  listHrDocs: (...a: unknown[]) => mockList(...a),
  ID_DOC_TYPES: new Set(["license", "passport", "state_id"]),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST, GET } from "../route";

const okAuth = () => ({
  ok: true,
  user: { id: "u", role: "hr", workspaceId: "w-1", email: "hr@x.com" },
  capabilities: new Set(),
});

function req(opts: { file: File; employee: string; docType: string; name?: string }): NextRequest {
  const fd = new FormData();
  fd.append("file", opts.file);
  fd.append("employee_email", opts.employee);
  if (opts.name) fd.append("employee_name", opts.name);
  fd.append("doc_type", opts.docType);
  return new NextRequest("https://x.test/api/hr/scanned-documents", {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: fd,
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockTrack.mockResolvedValue(undefined);
  mockIsFormRec.mockReturnValue(true);
  mockIsVision.mockReturnValue(true);
  mockFind.mockResolvedValue(null);
  mockInsert.mockResolvedValue({ id: "hr-1", status: "pending" });
});

describe("POST /api/hr/scanned-documents", () => {
  it("403 without hr.documents.upload", async () => {
    mockRequire.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    const res = await POST(req({ file: new File([new Uint8Array([1])], "x.jpg", { type: "image/jpeg" }), employee: "a@b.com", docType: "license" }));
    expect(res.status).toBe(403);
  });

  it("400 when employee_email missing or malformed", async () => {
    mockRequire.mockResolvedValue(okAuth());
    const res = await POST(req({ file: new File([new Uint8Array([1])], "x.jpg", { type: "image/jpeg" }), employee: "not-an-email", docType: "license" }));
    expect(res.status).toBe(400);
  });

  it("400 when doc_type isn't in the allowlist", async () => {
    mockRequire.mockResolvedValue(okAuth());
    const res = await POST(req({ file: new File([new Uint8Array([1])], "x.jpg", { type: "image/jpeg" }), employee: "a@b.com", docType: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("415 for disallowed MIME", async () => {
    mockRequire.mockResolvedValue(okAuth());
    const res = await POST(req({ file: new File([new Uint8Array([1])], "x.txt", { type: "text/plain" }), employee: "a@b.com", docType: "license" }));
    expect(res.status).toBe(415);
  });

  it("PII pre-scan refusal: 422 with blocked_by, no Azure call", async () => {
    mockRequire.mockResolvedValue(okAuth());
    const ssn = new File([new TextEncoder().encode("SSN 123-45-6789")], "x.png", { type: "image/png" });
    const res = await POST(req({ file: ssn, employee: "a@b.com", docType: "license" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("pii_blocked");
    expect(body.blocked_by).toContain("pii_ssn");
    expect(mockScanId).not.toHaveBeenCalled();
    expect(mockOcr).not.toHaveBeenCalled();
  });

  it("ID type → calls scanIdDocument; non-ID → calls ocrImage", async () => {
    mockRequire.mockResolvedValue(okAuth());
    mockScanId.mockResolvedValue({ ok: true, fields: { documentNumber: "D12345", dateOfExpiration: "2030-01-01", fullName: "Jane Doe", rawText: "...", documentConfidence: 0.93 } });
    const r1 = await POST(req({ file: new File([new Uint8Array([1, 2, 3])], "id.png", { type: "image/png" }), employee: "jane@x.com", docType: "license" }));
    expect(r1.status).toBe(200);
    expect(mockScanId).toHaveBeenCalled();
    expect(mockOcr).not.toHaveBeenCalled();

    mockScanId.mockReset(); mockOcr.mockReset();
    mockOcr.mockResolvedValue({ ok: true, text: "W-9 form contents...", pages: 1, emptyImage: false });
    const r2 = await POST(req({ file: new File([new Uint8Array([1, 2, 3])], "w9.pdf", { type: "application/pdf" }), employee: "jane@x.com", docType: "w9" }));
    expect(r2.status).toBe(200);
    expect(mockOcr).toHaveBeenCalled();
    expect(mockScanId).not.toHaveBeenCalled();
  });

  it("dedup: cached SHA returns existing row + skips Azure", async () => {
    mockRequire.mockResolvedValue(okAuth());
    mockFind.mockResolvedValue({ id: "existing", status: "verified" });
    const res = await POST(req({ file: new File([new Uint8Array([1, 2, 3])], "id.png", { type: "image/png" }), employee: "jane@x.com", docType: "license" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.document_id).toBe("existing");
    expect(mockScanId).not.toHaveBeenCalled();
  });
});

describe("GET /api/hr/scanned-documents", () => {
  it("403 without view cap", async () => {
    mockRequire.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    const res = await GET(new NextRequest("https://x.test/api/hr/scanned-documents"));
    expect(res.status).toBe(403);
  });

  it("lists with employee filter applied", async () => {
    mockRequire.mockResolvedValue(okAuth());
    mockList.mockResolvedValue([{ id: "1", employee_email: "jane@x.com" }]);
    const res = await GET(new NextRequest("https://x.test/api/hr/scanned-documents?employee_email=jane@x.com&status=verified"));
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ employeeEmail: "jane@x.com", status: "verified" }));
  });
});
