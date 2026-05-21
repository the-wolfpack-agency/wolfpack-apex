/**
 * Tests focus on `mapReceiptFields` (pure mapper) + the rejection
 * paths in `scanReceipt`. The Graph round-trip itself is covered by
 * the API contract test downstream.
 */

import {
  mapReceiptFields,
  mapInvoiceFields,
  scanReceipt,
  scanInvoice,
  RECEIPT_MAX_BYTES,
  isFormRecognizerConfigured,
} from "@/lib/azure/form-recognizer";

jest.mock("@/lib/azure/audit", () => ({
  recordAzureCall: jest.fn().mockResolvedValue(undefined),
}));

describe("mapReceiptFields", () => {
  it("returns null when the response has no documents", () => {
    expect(mapReceiptFields({})).toBeNull();
    expect(mapReceiptFields({ analyzeResult: {} })).toBeNull();
    expect(mapReceiptFields({ analyzeResult: { documents: [] } })).toBeNull();
  });

  it("pulls merchant / date / total / currency from canonical fields", () => {
    const out = mapReceiptFields({
      analyzeResult: {
        content: "Acme Hardware\n2026-05-21\nTotal $124.50",
        documents: [
          {
            confidence: 0.97,
            fields: {
              MerchantName: { valueString: "Acme Hardware", confidence: 0.99 },
              TransactionDate: { valueDate: "2026-05-21", confidence: 0.95 },
              Total: { valueCurrency: { amount: 124.5, currencyCode: "USD" }, confidence: 0.93 },
              Subtotal: { valueCurrency: { amount: 115.0 } },
              TotalTax: { valueCurrency: { amount: 9.5 } },
              Items: {
                valueArray: [
                  {
                    valueObject: {
                      Description: { valueString: "Hammer" },
                      TotalPrice: { valueCurrency: { amount: 24.99 } },
                      Quantity: { valueNumber: 1 },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    });
    expect(out).toBeTruthy();
    expect(out!.merchantName).toBe("Acme Hardware");
    expect(out!.transactionDate).toBe("2026-05-21");
    expect(out!.total).toBe(124.5);
    expect(out!.currency).toBe("USD");
    expect(out!.subtotal).toBe(115);
    expect(out!.tax).toBe(9.5);
    expect(out!.items).toEqual([
      { description: "Hammer", totalPrice: 24.99, quantity: 1 },
    ]);
    expect(out!.documentConfidence).toBe(0.97);
    expect(out!.rawText).toBe("Acme Hardware\n2026-05-21\nTotal $124.50");
  });

  it("falls back to VendorName/InvoiceDate/InvoiceTotal for invoice-shaped docs", () => {
    const out = mapReceiptFields({
      analyzeResult: {
        documents: [{
          fields: {
            VendorName: { valueString: "Globex Inc." },
            InvoiceDate: { valueDate: "2026-05-21" },
            InvoiceTotal: { valueCurrency: { amount: 999, currencyCode: "USD" } },
          },
        }],
      },
    });
    expect(out!.merchantName).toBe("Globex Inc.");
    expect(out!.transactionDate).toBe("2026-05-21");
    expect(out!.total).toBe(999);
  });

  it("truncates rawText at 2000 chars (cap for prompt-safety)", () => {
    const long = "x".repeat(3000);
    const out = mapReceiptFields({
      analyzeResult: { content: long, documents: [{ fields: {} }] },
    });
    expect(out!.rawText.length).toBe(2000);
  });
});

describe("mapInvoiceFields", () => {
  it("returns null when no documents", () => {
    expect(mapInvoiceFields({})).toBeNull();
    expect(mapInvoiceFields({ analyzeResult: { documents: [] } })).toBeNull();
  });

  it("pulls vendor / invoice id / dates / totals / currency / line items", () => {
    const out = mapInvoiceFields({
      analyzeResult: {
        content: "Vendor: Acme\nInvoice INV-12345",
        documents: [{
          confidence: 0.96,
          fields: {
            VendorName: { valueString: "Acme Corp" },
            CustomerName: { valueString: "Wolfpack Agency" },
            InvoiceId: { valueString: "INV-12345" },
            InvoiceDate: { valueDate: "2026-05-15" },
            DueDate: { valueDate: "2026-06-15" },
            SubTotal: { valueCurrency: { amount: 1000, currencyCode: "USD" } },
            TotalTax: { valueCurrency: { amount: 80 } },
            InvoiceTotal: { valueCurrency: { amount: 1080, currencyCode: "USD" } },
            Items: {
              valueArray: [
                {
                  valueObject: {
                    Description: { valueString: "Consulting" },
                    Amount: { valueCurrency: { amount: 1000 } },
                    Quantity: { valueNumber: 10 },
                    UnitPrice: { valueCurrency: { amount: 100 } },
                  },
                },
              ],
            },
          },
        }],
      },
    });
    expect(out).toBeTruthy();
    expect(out!.vendorName).toBe("Acme Corp");
    expect(out!.customerName).toBe("Wolfpack Agency");
    expect(out!.invoiceId).toBe("INV-12345");
    expect(out!.invoiceDate).toBe("2026-05-15");
    expect(out!.dueDate).toBe("2026-06-15");
    expect(out!.subtotal).toBe(1000);
    expect(out!.totalTax).toBe(80);
    expect(out!.invoiceTotal).toBe(1080);
    expect(out!.currency).toBe("USD");
    expect(out!.lineItems).toEqual([
      { description: "Consulting", amount: 1000, quantity: 10, unitPrice: 100, productCode: null },
    ]);
    expect(out!.documentConfidence).toBe(0.96);
    expect(out!.rawText).toContain("INV-12345");
  });
});

describe("scanInvoice — guard rails", () => {
  it("refuses too_large without firing fetch", async () => {
    global.fetch = jest.fn();
    const big = Buffer.alloc(RECEIPT_MAX_BYTES + 1);
    const r = await scanInvoice(big, { triggeredBy: "u", triggeredByRole: "cto", contentType: "application/pdf" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("scanReceipt — guard rails before Azure call", () => {
  /* These tests don't exercise Azure; they pin the rejection paths
     that MUST refuse before burning a free-tier transaction. */
  const ENV_KEYS = ["AZURE_VISION_ENDPOINT", "AZURE_VISION_KEY", "AZURE_FORM_REC_ENDPOINT", "AZURE_FORM_REC_KEY", "AZURE_COGNITIVE_ENDPOINT", "AZURE_COGNITIVE_KEY"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("refuses too_large WITHOUT firing any fetch", async () => {
    global.fetch = jest.fn();
    const big = Buffer.alloc(RECEIPT_MAX_BYTES + 1);
    const r = await scanReceipt(big, { triggeredBy: "u", triggeredByRole: "cto", contentType: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_large");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses not_configured WITHOUT firing any fetch", async () => {
    global.fetch = jest.fn();
    const small = Buffer.from("hello");
    expect(isFormRecognizerConfigured()).toBe(false);
    const r = await scanReceipt(small, { triggeredBy: "u", triggeredByRole: "cto", contentType: "image/png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
