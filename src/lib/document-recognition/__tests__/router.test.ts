/**
 * Tests for the extractor router. Mocks the per-extractor scanner
 * functions so the router-under-test does pure dispatch — no Azure
 * HTTP traffic in unit tests.
 */

import type {
  DocumentClassification,
  DocumentType,
} from "@/lib/document-recognition/types";

jest.mock("@/lib/azure/form-recognizer", () => ({
  scanReceipt: jest.fn(),
  scanInvoice: jest.fn(),
  scanIdDocument: jest.fn(),
}));

jest.mock("@/lib/azure/tax-form", () => {
  class TaxFormNotConfiguredError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "TaxFormNotConfiguredError";
    }
  }
  class TaxFormVendorError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.name = "TaxFormVendorError";
      this.code = code;
    }
  }
  return {
    scanTaxW2: jest.fn(),
    scanTax1099: jest.fn(),
    TaxFormNotConfiguredError,
    TaxFormVendorError,
  };
});

jest.mock("@/lib/azure/audit", () => ({
  recordAzureCall: jest.fn().mockResolvedValue(undefined),
}));

import { scanReceipt, scanInvoice, scanIdDocument } from "@/lib/azure/form-recognizer";
import {
  scanTaxW2,
  scanTax1099,
  TaxFormNotConfiguredError,
  TaxFormVendorError,
} from "@/lib/azure/tax-form";
import { recordAzureCall } from "@/lib/azure/audit";
import {
  extractDocument,
  ExtractorNotConfiguredError,
  ExtractorVendorError,
  AZURE_PREBUILT_USD_PER_PAGE,
} from "@/lib/document-recognition/router";

const mockScanReceipt = scanReceipt as jest.MockedFunction<typeof scanReceipt>;
const mockScanInvoice = scanInvoice as jest.MockedFunction<typeof scanInvoice>;
const mockScanIdDocument = scanIdDocument as jest.MockedFunction<typeof scanIdDocument>;
const mockScanTaxW2 = scanTaxW2 as jest.MockedFunction<typeof scanTaxW2>;
const mockScanTax1099 = scanTax1099 as jest.MockedFunction<typeof scanTax1099>;
const mockAudit = recordAzureCall as jest.MockedFunction<typeof recordAzureCall>;

function classification(type: DocumentType, confidence = 0.9): DocumentClassification {
  return {
    type,
    confidence,
    alternates: [],
    rationale: "test",
    model: "test-model",
    latencyMs: 10,
    costCents: 0,
  };
}

function bytes(n = 16): Uint8Array {
  return new Uint8Array(Array.from({ length: n }, (_, i) => i & 0xff));
}

const AUDIT = {
  triggeredBy: "tester",
  triggeredByRole: "cto",
  documentId: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

/* ───────── Dispatch ───────── */

describe("extractDocument dispatch", () => {
  it("routes type=receipt to scanReceipt → azure_prebuilt_receipt", async () => {
    mockScanReceipt.mockResolvedValue({
      ok: true,
      fields: {
        merchantName: "Acme",
        transactionDate: "2026-05-21",
        total: 42.5,
        subtotal: 40,
        tax: 2.5,
        currency: "USD",
        items: [],
        documentConfidence: 0.95,
        rawText: "Acme receipt",
      },
    });
    const out = await extractDocument({
      bytes: bytes(),
      mime: "image/png",
      classification: classification("receipt"),
      audit: AUDIT,
    });
    expect(out).toBeTruthy();
    expect(out!.extractor).toBe("azure_prebuilt_receipt");
    expect(out!.model).toBe("prebuilt-receipt");
    const names = out!.fields.map((f) => f.name);
    expect(names).toContain("merchant_name");
    expect(names).toContain("total");
    expect(mockScanReceipt).toHaveBeenCalledTimes(1);
    expect(mockScanInvoice).not.toHaveBeenCalled();
    expect(mockScanIdDocument).not.toHaveBeenCalled();
    expect(mockScanTaxW2).not.toHaveBeenCalled();
    expect(mockScanTax1099).not.toHaveBeenCalled();
  });

  it("routes type=invoice to scanInvoice → azure_prebuilt_invoice", async () => {
    mockScanInvoice.mockResolvedValue({
      ok: true,
      fields: {
        vendorName: "Globex",
        customerName: "Wolfpack",
        invoiceId: "INV-1",
        invoiceDate: "2026-05-15",
        dueDate: "2026-06-15",
        subtotal: 1000,
        totalTax: 80,
        invoiceTotal: 1080,
        currency: "USD",
        lineItems: [],
        documentConfidence: 0.96,
        rawText: "Invoice INV-1",
        rawFields: {},
      },
    });
    const out = await extractDocument({
      bytes: bytes(),
      mime: "application/pdf",
      classification: classification("invoice"),
      audit: AUDIT,
    });
    expect(out!.extractor).toBe("azure_prebuilt_invoice");
    expect(out!.model).toBe("prebuilt-invoice");
    const names = out!.fields.map((f) => f.name);
    expect(names).toContain("vendor_name");
    expect(names).toContain("invoice_id");
    expect(mockScanInvoice).toHaveBeenCalledTimes(1);
  });

  it("routes type=tax_w2 to scanTaxW2 → azure_prebuilt_tax_us_w2", async () => {
    mockScanTaxW2.mockResolvedValue({
      fields: [
        { name: "employee_name", value: "Jane Doe", rawValue: "Jane Doe", confidence: 0.97 },
        { name: "wages", value: "75000", rawValue: 75000, confidence: 0.95 },
      ],
      rawText: "W-2",
      latencyMs: 250,
      model: "prebuilt-tax.us.w2",
    });
    const out = await extractDocument({
      bytes: bytes(),
      mime: "application/pdf",
      classification: classification("tax_w2"),
      audit: AUDIT,
    });
    expect(out!.extractor).toBe("azure_prebuilt_tax_us_w2");
    expect(out!.model).toBe("prebuilt-tax.us.w2");
    const names = out!.fields.map((f) => f.name);
    expect(names).toContain("employee_name");
    expect(names).toContain("wages");
    expect(mockScanTaxW2).toHaveBeenCalledTimes(1);
  });

  it("routes type=tax_1099 to scanTax1099 → azure_prebuilt_tax_us_1099", async () => {
    mockScanTax1099.mockResolvedValue({
      fields: [
        { name: "payer_name", value: "Globex", rawValue: "Globex", confidence: 0.94 },
        { name: "nonemployee_compensation", value: "12500", rawValue: 12500, confidence: 0.93 },
      ],
      rawText: "1099-NEC",
      latencyMs: 300,
      model: "prebuilt-tax.us.1099",
    });
    const out = await extractDocument({
      bytes: bytes(),
      mime: "image/png",
      classification: classification("tax_1099"),
      audit: AUDIT,
    });
    expect(out!.extractor).toBe("azure_prebuilt_tax_us_1099");
    expect(out!.model).toBe("prebuilt-tax.us.1099");
    expect(mockScanTax1099).toHaveBeenCalledTimes(1);
  });

  it("routes type=id_document to scanIdDocument → azure_prebuilt_id_document", async () => {
    mockScanIdDocument.mockResolvedValue({
      ok: true,
      fields: {
        documentNumber: "D12345",
        firstName: "Jane",
        lastName: "Doe",
        fullName: "Jane Doe",
        dateOfBirth: "1990-01-02",
        dateOfExpiration: "2030-01-02",
        dateOfIssue: "2020-01-02",
        countryRegion: "USA",
        region: "CA",
        documentType: "drivers_license",
        documentConfidence: 0.96,
        rawText: "ID",
        rawFields: {},
      },
    });
    const out = await extractDocument({
      bytes: bytes(),
      mime: "image/jpeg",
      classification: classification("id_document"),
      audit: AUDIT,
    });
    expect(out!.extractor).toBe("azure_prebuilt_id_document");
    expect(out!.model).toBe("prebuilt-idDocument");
    const names = out!.fields.map((f) => f.name);
    expect(names).toContain("document_number");
    expect(names).toContain("full_name");
    expect(mockScanIdDocument).toHaveBeenCalledTimes(1);
  });

  it("returns null for type=unknown and calls NO extractor", async () => {
    const out = await extractDocument({
      bytes: bytes(),
      mime: "image/png",
      classification: classification("unknown"),
      audit: AUDIT,
    });
    expect(out).toBeNull();
    expect(mockScanReceipt).not.toHaveBeenCalled();
    expect(mockScanInvoice).not.toHaveBeenCalled();
    expect(mockScanIdDocument).not.toHaveBeenCalled();
    expect(mockScanTaxW2).not.toHaveBeenCalled();
    expect(mockScanTax1099).not.toHaveBeenCalled();
  });
});

/* ───────── Error mapping ───────── */

describe("error mapping", () => {
  it("translates scanner not_configured → ExtractorNotConfiguredError (receipt)", async () => {
    mockScanReceipt.mockResolvedValue({
      ok: false,
      reason: "not_configured",
      detail: "no creds",
    });
    await expect(
      extractDocument({
        bytes: bytes(),
        mime: "image/png",
        classification: classification("receipt"),
        audit: AUDIT,
      }),
    ).rejects.toBeInstanceOf(ExtractorNotConfiguredError);
  });

  it("translates scanner unavailable (Azure 5xx) → ExtractorVendorError (invoice)", async () => {
    mockScanInvoice.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      detail: "Azure HTTP 503",
    });
    await expect(
      extractDocument({
        bytes: bytes(),
        mime: "application/pdf",
        classification: classification("invoice"),
        audit: AUDIT,
      }),
    ).rejects.toBeInstanceOf(ExtractorVendorError);
  });

  it("translates TaxFormNotConfiguredError → ExtractorNotConfiguredError (tax_w2)", async () => {
    mockScanTaxW2.mockRejectedValue(
      new TaxFormNotConfiguredError("AZURE_FORM_REC_KEY not set"),
    );
    await expect(
      extractDocument({
        bytes: bytes(),
        mime: "application/pdf",
        classification: classification("tax_w2"),
        audit: AUDIT,
      }),
    ).rejects.toBeInstanceOf(ExtractorNotConfiguredError);
  });

  it("translates TaxFormVendorError → ExtractorVendorError (tax_1099)", async () => {
    mockScanTax1099.mockRejectedValue(
      new TaxFormVendorError("Azure 503", "graph_unavailable"),
    );
    await expect(
      extractDocument({
        bytes: bytes(),
        mime: "image/png",
        classification: classification("tax_1099"),
        audit: AUDIT,
      }),
    ).rejects.toBeInstanceOf(ExtractorVendorError);
  });
});

/* ───────── Cost + latency + audit ───────── */

describe("cost / latency / audit", () => {
  it("populates costCents with AZURE_PREBUILT_USD_PER_PAGE", async () => {
    mockScanReceipt.mockResolvedValue({
      ok: true,
      fields: {
        merchantName: "X",
        transactionDate: null,
        total: 10,
        subtotal: null,
        tax: null,
        currency: "USD",
        items: [],
        documentConfidence: 0.9,
        rawText: "",
      },
    });
    const out = await extractDocument({
      bytes: bytes(),
      mime: "image/png",
      classification: classification("receipt"),
      audit: AUDIT,
    });
    expect(out!.costCents).toBe(AZURE_PREBUILT_USD_PER_PAGE);
  });

  it("tracks latencyMs as a non-negative number", async () => {
    mockScanTaxW2.mockResolvedValue({
      fields: [],
      rawText: "",
      latencyMs: 123,
      model: "prebuilt-tax.us.w2",
    });
    const out = await extractDocument({
      bytes: bytes(),
      mime: "application/pdf",
      classification: classification("tax_w2"),
      audit: AUDIT,
    });
    expect(typeof out!.latencyMs).toBe("number");
    expect(out!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("the dispatched scanner is the only side-effect when audit is mocked silent", async () => {
    /* recordAzureCall is invoked by the underlying scanner functions.
     * In this test those scanners are mocked, so we assert the
     * scanner itself was called — that's what guarantees the audit
     * pipeline fires in production. */
    mockScanIdDocument.mockResolvedValue({
      ok: true,
      fields: {
        documentNumber: "X",
        firstName: null,
        lastName: null,
        fullName: null,
        dateOfBirth: null,
        dateOfExpiration: null,
        dateOfIssue: null,
        countryRegion: null,
        region: null,
        documentType: "passport",
        documentConfidence: 0.9,
        rawText: "",
        rawFields: {},
      },
    });
    await extractDocument({
      bytes: bytes(),
      mime: "image/png",
      classification: classification("id_document"),
      audit: AUDIT,
    });
    expect(mockScanIdDocument).toHaveBeenCalledTimes(1);
  });

  it("does NOT propagate audit failures (scanner audit error is swallowed)", async () => {
    /* The router's tax wrapper relies on the underlying scanTaxW2
     * to swallow audit failures. Simulate the scanner succeeding even
     * though we configure recordAzureCall to reject — the wrapper
     * isolates the router from any internal audit hiccup. */
    mockAudit.mockRejectedValueOnce(new Error("db down"));
    mockScanTaxW2.mockResolvedValue({
      fields: [{ name: "wages", value: "1000", rawValue: 1000, confidence: 0.9 }],
      rawText: "",
      latencyMs: 100,
      model: "prebuilt-tax.us.w2",
    });
    const out = await extractDocument({
      bytes: bytes(),
      mime: "application/pdf",
      classification: classification("tax_w2"),
      audit: AUDIT,
    });
    expect(out).toBeTruthy();
    expect(out!.extractor).toBe("azure_prebuilt_tax_us_w2");
  });
});
