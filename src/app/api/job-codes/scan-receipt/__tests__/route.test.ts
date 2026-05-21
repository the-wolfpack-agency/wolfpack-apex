/**
 * Contract tests for POST /api/job-codes/scan-receipt + /[id]/apply.
 *
 * Pins:
 *   - Auth + capability (jobcodes.refresh) on both.
 *   - 503 when Form Recognizer isn't configured (don't burn a 4xx on
 *     a transient config issue).
 *   - MIME allowlist (415 for disallowed types).
 *   - 413 when over RECEIPT_MAX_BYTES.
 *   - Dedup: same SHA-256 returns the cached row without firing the
 *     Azure call again.
 *   - Apply endpoint records committed values for the learning loop.
 */

export {};

const mockRequireCapability = jest.fn();
const mockScanReceipt = jest.fn();
const mockIsConfigured = jest.fn();
const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/azure/form-recognizer", () => ({
  scanReceipt: (...a: unknown[]) => mockScanReceipt(...a),
  isFormRecognizerConfigured: () => mockIsConfigured(),
  RECEIPT_MAX_BYTES: 3.5 * 1024 * 1024,
}));
jest.mock("@/lib/db", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST as SCAN } from "../route";
import { POST as APPLY } from "../[id]/apply/route";

function makeMultipart(file: File, action = "scan-receipt"): NextRequest {
  const fd = new FormData();
  fd.append("file", file);
  return new NextRequest(`https://x.test/api/job-codes/${action}`, {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: fd,
  });
}

function makeJsonReq(path: string, body: unknown): NextRequest {
  return new NextRequest(`https://x.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const okAuth = (overrides: { id?: string; role?: string; workspaceId?: string } = {}) => ({
  ok: true,
  user: {
    id: overrides.id ?? "u-1",
    role: overrides.role ?? "cto",
    workspaceId: overrides.workspaceId ?? "w-1",
    email: "homyk@thewolfpack.agency",
  },
  capabilities: new Set(),
});

beforeEach(() => {
  jest.resetAllMocks();
  mockTrackEvent.mockResolvedValue(undefined);
  mockIsConfigured.mockReturnValue(true);
  mockQuery.mockResolvedValue({ rows: [] });
  mockWriteQuery.mockResolvedValue({ rows: [{ id: "scan-1" }] });
});

describe("POST /api/job-codes/scan-receipt — auth + gates", () => {
  it("returns 403 when caller lacks jobcodes.refresh", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await SCAN(makeMultipart(file));
    expect(res.status).toBe(403);
    expect(mockScanReceipt).not.toHaveBeenCalled();
  });

  it("returns 503 when Form Recognizer isn't configured", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockIsConfigured.mockReturnValue(false);
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await SCAN(makeMultipart(file));
    expect(res.status).toBe(503);
    expect(mockScanReceipt).not.toHaveBeenCalled();
  });

  it("rejects disallowed MIME with 415 BEFORE firing Azure", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const file = new File([new Uint8Array([1])], "x.txt", { type: "text/plain" });
    const res = await SCAN(makeMultipart(file));
    expect(res.status).toBe(415);
    expect(mockScanReceipt).not.toHaveBeenCalled();
  });

  it("rejects oversize with 413 BEFORE firing Azure", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    /* Real ~5 MB buffer so the File.size getter reports the right
       value — Object.defineProperty silently fails on File.size in
       jsdom because it's defined as a non-configurable getter. */
    const huge = new File([new Uint8Array(5 * 1024 * 1024)], "x.png", { type: "image/png" });
    const res = await SCAN(makeMultipart(huge));
    expect(res.status).toBe(413);
    expect(mockScanReceipt).not.toHaveBeenCalled();
  });
});

describe("POST /api/job-codes/scan-receipt — dedup", () => {
  it("returns the cached row + skips the Azure call when SHA matches", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "existing-scan",
        fields: { merchantName: "Acme", total: 100, items: [] },
        uploaded_at: "2026-05-21T10:00:00Z",
      }],
    });
    const file = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    const res = await SCAN(makeMultipart(file));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.scan_id).toBe("existing-scan");
    expect(mockScanReceipt).not.toHaveBeenCalled();
  });
});

describe("POST /api/job-codes/scan-receipt — happy path", () => {
  it("calls Azure, persists the scan, returns fields + scan_id", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockScanReceipt.mockResolvedValue({
      ok: true,
      fields: {
        merchantName: "Acme",
        transactionDate: "2026-05-21",
        total: 124.5,
        subtotal: 115,
        tax: 9.5,
        currency: "USD",
        items: [],
        documentConfidence: 0.95,
        rawText: "Acme\n2026-05-21\nTotal $124.50",
      },
    });
    const file = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    const res = await SCAN(makeMultipart(file));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cached).toBe(false);
    expect(body.scan_id).toBe("scan-1");
    expect(body.fields.merchantName).toBe("Acme");
    expect(mockWriteQuery).toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "jobcodes.receipt_scanned",
      "u-1",
      "cto",
      expect.objectContaining({ cached: false, merchant: "Acme" }),
    );
  });

  it("returns 429 when Azure rate-limits", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockScanReceipt.mockResolvedValue({
      ok: false,
      reason: "rate_limited",
      detail: "throttled",
    });
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await SCAN(makeMultipart(file));
    expect(res.status).toBe(429);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "jobcodes.receipt_scan_failed",
      "u-1",
      "cto",
      expect.objectContaining({ reason: "rate_limited" }),
    );
  });
});

describe("POST /api/job-codes/scan-receipt/[id]/apply", () => {
  it("requires a code in the body", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const res = await APPLY(makeJsonReq("/api/job-codes/scan-receipt/scan-1/apply", { code: "" }), { params: Promise.resolve({ id: "scan-1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 when no scan row matches", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const res = await APPLY(
      makeJsonReq("/api/job-codes/scan-receipt/scan-1/apply", { code: "WPA-1" }),
      { params: Promise.resolve({ id: "scan-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("records committed values + fires analytics", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "scan-1" }] });
    const res = await APPLY(
      makeJsonReq("/api/job-codes/scan-receipt/scan-1/apply", {
        code: "WPA-1",
        program: "Phase 2",
        po_number: "PO-9",
        po_amount: "124.50",
      }),
      { params: Promise.resolve({ id: "scan-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "jobcodes.receipt_applied",
      "u-1",
      "cto",
      expect.objectContaining({
        scan_id: "scan-1",
        code: "WPA-1",
        applied_program: true,
        applied_po_number: true,
        applied_po_amount: true,
      }),
    );
  });
});
