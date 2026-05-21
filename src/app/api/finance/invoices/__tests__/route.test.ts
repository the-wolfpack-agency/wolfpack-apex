/**
 * Contract tests for /api/finance/invoices + /[id].
 * Pins capability gates, dedup, MIME/size guards, status-transition
 * guard on PATCH, delete protection on active rows.
 */

export {};

const mockRequireCapability = jest.fn();
const mockScanInvoice = jest.fn();
const mockIsConfigured = jest.fn();
const mockFindBySha = jest.fn();
const mockInsert = jest.fn();
const mockList = jest.fn();
const mockGet = jest.fn();
const mockPatch = jest.fn();
const mockDelete = jest.fn();
const mockCountByStatus = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/azure/form-recognizer", () => ({
  scanInvoice: (...a: unknown[]) => mockScanInvoice(...a),
  isFormRecognizerConfigured: () => mockIsConfigured(),
  RECEIPT_MAX_BYTES: 3.5 * 1024 * 1024,
}));
jest.mock("@/lib/finance/invoices", () => ({
  findInvoiceBySha: (...a: unknown[]) => mockFindBySha(...a),
  insertInvoice: (...a: unknown[]) => mockInsert(...a),
  listInvoices: (...a: unknown[]) => mockList(...a),
  countInvoicesByStatus: (...a: unknown[]) => mockCountByStatus(...a),
  getInvoice: (...a: unknown[]) => mockGet(...a),
  patchInvoice: (...a: unknown[]) => mockPatch(...a),
  deleteInvoice: (...a: unknown[]) => mockDelete(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET, POST } from "../route";
import { PATCH, DELETE } from "../[id]/route";

const okAuth = (overrides: { id?: string; role?: string; workspaceId?: string } = {}) => ({
  ok: true,
  user: {
    id: overrides.id ?? "u",
    role: overrides.role ?? "cto",
    workspaceId: overrides.workspaceId ?? "w-1",
    email: "homyk@thewolfpack.agency",
  },
  capabilities: new Set(),
});

function multipartReq(file: File): NextRequest {
  const fd = new FormData();
  fd.append("file", file);
  return new NextRequest("https://x.test/api/finance/invoices", {
    method: "POST",
    headers: { authorization: "Bearer test" },
    body: fd,
  });
}

function jsonReq(path: string, body: unknown, method: "GET" | "PATCH" | "DELETE" = "PATCH"): NextRequest {
  return new NextRequest(`https://x.test${path}`, {
    method,
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockTrack.mockResolvedValue(undefined);
  mockIsConfigured.mockReturnValue(true);
  mockCountByStatus.mockResolvedValue({ pending: 0, approved: 0, paid: 0, rejected: 0 });
});

describe("GET /api/finance/invoices", () => {
  it("returns 403 when caller lacks view capability", async () => {
    mockRequireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    const res = await GET(new NextRequest("https://x.test/api/finance/invoices"));
    expect(res.status).toBe(403);
  });

  it("returns invoices filtered by status", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockList.mockResolvedValue([{ id: "inv-1", status: "pending" }]);
    const res = await GET(new NextRequest("https://x.test/api/finance/invoices?status=pending"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  /* Regression for the 2026-05-21 chip-count bug: counts MUST come
     from the workspace-wide aggregate, not just the loaded slice.
     Otherwise "Rejected (0)" lies when the filter is "Pending" but
     a rejected row exists. */
  it("returns workspace-wide counts independent of the filter", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockList.mockResolvedValue([{ id: "inv-1", status: "pending" }]);
    mockCountByStatus.mockResolvedValueOnce({ pending: 1, approved: 0, paid: 0, rejected: 4 });
    const res = await GET(new NextRequest("https://x.test/api/finance/invoices?status=pending"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ pending: 1, approved: 0, paid: 0, rejected: 4 });
  });
});

describe("POST /api/finance/invoices — scan + persist", () => {
  it("requires manage capability (403)", async () => {
    mockRequireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
    const res = await POST(multipartReq(file));
    expect(res.status).toBe(403);
    expect(mockScanInvoice).not.toHaveBeenCalled();
  });

  it("503 when Form Recognizer not configured", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockIsConfigured.mockReturnValue(false);
    const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
    const res = await POST(multipartReq(file));
    expect(res.status).toBe(503);
  });

  it("415 for disallowed MIME", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    const file = new File([new Uint8Array([1])], "x.txt", { type: "text/plain" });
    const res = await POST(multipartReq(file));
    expect(res.status).toBe(415);
    expect(mockScanInvoice).not.toHaveBeenCalled();
  });

  it("dedup: returns cached row + skips Azure when SHA matches", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySha.mockResolvedValueOnce({
      id: "existing-inv",
      fields: { vendorName: "Acme", invoiceTotal: 1000 },
      status: "pending",
      uploaded_at: "2026-05-21T00:00:00Z",
    });
    const file = new File([new Uint8Array([1, 2, 3])], "x.pdf", { type: "application/pdf" });
    const res = await POST(multipartReq(file));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.invoice_id).toBe("existing-inv");
    expect(mockScanInvoice).not.toHaveBeenCalled();
  });

  it("happy path: scans, inserts, returns invoice_id + fields", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySha.mockResolvedValue(null);
    mockScanInvoice.mockResolvedValue({
      ok: true,
      fields: {
        vendorName: "Acme", customerName: null, invoiceId: "INV-1",
        invoiceDate: "2026-05-15", dueDate: "2026-06-15",
        subtotal: 1000, totalTax: 80, invoiceTotal: 1080, currency: "USD",
        lineItems: [], documentConfidence: 0.95, rawText: "", rawFields: {},
      },
    });
    mockInsert.mockResolvedValue({ id: "inv-new", status: "pending" });
    const file = new File([new Uint8Array([1, 2, 3])], "inv.pdf", { type: "application/pdf" });
    const res = await POST(multipartReq(file));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invoice_id).toBe("inv-new");
    expect(body.status).toBe("pending");
    expect(mockTrack).toHaveBeenCalledWith(
      "finance.invoice_scanned", "u", "cto",
      expect.objectContaining({ cached: false, vendor: "Acme", total: 1080 }),
    );
  });

  it("429 when Azure rate-limits", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockFindBySha.mockResolvedValue(null);
    mockScanInvoice.mockResolvedValue({ ok: false, reason: "rate_limited", detail: "throttled" });
    const file = new File([new Uint8Array([1])], "x.pdf", { type: "application/pdf" });
    const res = await POST(multipartReq(file));
    expect(res.status).toBe(429);
    expect(mockTrack).toHaveBeenCalledWith(
      "finance.invoice_scan_failed", "u", "cto",
      expect.objectContaining({ reason: "rate_limited" }),
    );
  });
});

describe("PATCH /api/finance/invoices/[id] — status transitions", () => {
  it("rejects invalid status transition (pending → paid)", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockGet.mockResolvedValueOnce({ status: "pending" });
    const res = await PATCH(
      jsonReq("/api/finance/invoices/inv-1", { status: "paid" }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_status_transition");
  });

  it("approves pending → fires approved event", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockGet.mockResolvedValueOnce({ status: "pending" });
    mockPatch.mockResolvedValue({ id: "inv-1", status: "approved", vendor_name: "Acme", total: "1080" });
    const res = await PATCH(
      jsonReq("/api/finance/invoices/inv-1", { status: "approved" }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockTrack).toHaveBeenCalledWith(
      "finance.invoice_approved", "u", "cto",
      expect.objectContaining({ invoice_id: "inv-1", vendor: "Acme" }),
    );
  });

  it("fires updated event for non-status field changes", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockPatch.mockResolvedValue({ id: "inv-1", status: "pending", notes: "checked", vendor_name: null, total: null });
    const res = await PATCH(
      jsonReq("/api/finance/invoices/inv-1", { notes: "checked" }),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockTrack).toHaveBeenCalledWith(
      "finance.invoice_updated", "u", "cto",
      expect.objectContaining({ changed_keys: "notes" }),
    );
  });
});

describe("DELETE /api/finance/invoices/[id]", () => {
  it("refuses to delete pending/approved invoices (409)", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockGet.mockResolvedValueOnce({ status: "pending", vendor_name: "Acme" });
    const res = await DELETE(
      jsonReq("/api/finance/invoices/inv-1", null, "DELETE"),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(409);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes paid invoice and fires event", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockGet.mockResolvedValueOnce({ status: "paid", vendor_name: "Acme" });
    mockDelete.mockResolvedValue(true);
    const res = await DELETE(
      jsonReq("/api/finance/invoices/inv-1", null, "DELETE"),
      { params: Promise.resolve({ id: "inv-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockTrack).toHaveBeenCalledWith(
      "finance.invoice_deleted", "u", "cto",
      expect.objectContaining({ invoice_id: "inv-1" }),
    );
  });
});
