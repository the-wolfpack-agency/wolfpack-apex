/**
 * Tests focus on `mapReceiptFields` (pure mapper) + the rejection
 * paths in `scanReceipt`. The Graph round-trip itself is covered by
 * the API contract test downstream.
 */

import {
  mapReceiptFields,
  scanReceipt,
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
