/**
 * Tests for the Azure prebuilt-tax.us.w2 + prebuilt-tax.us.1099
 * extractors. Mocks the Azure client wrappers (postAzure +
 * pollAzureOperation) so no real HTTP traffic leaves the test
 * process. Mocks the audit hook to spy on call-context wiring
 * without needing a Postgres in jest.
 */

import type { AzureCallContext } from "@/lib/azure/audit";

jest.mock("@/lib/azure/client", () => ({
  resolveAzureCreds: jest.fn(),
  postAzure: jest.fn(),
  pollAzureOperation: jest.fn(),
}));

jest.mock("@/lib/azure/audit", () => ({
  recordAzureCall: jest.fn().mockResolvedValue(undefined),
}));

import {
  resolveAzureCreds,
  postAzure,
  pollAzureOperation,
} from "@/lib/azure/client";
import { recordAzureCall } from "@/lib/azure/audit";
import {
  scanTaxW2,
  scanTax1099,
  isTaxFormConfigured,
  mapTaxFields,
  TaxFormNotConfiguredError,
  TaxFormVendorError,
  TAX_FORM_MAX_BYTES,
} from "@/lib/azure/tax-form";

const mockResolveCreds = resolveAzureCreds as jest.MockedFunction<typeof resolveAzureCreds>;
const mockPostAzure = postAzure as jest.MockedFunction<typeof postAzure>;
const mockPoll = pollAzureOperation as jest.MockedFunction<typeof pollAzureOperation>;
const mockAudit = recordAzureCall as jest.MockedFunction<typeof recordAzureCall>;

const FAKE_CREDS = { endpoint: "https://fake.cognitiveservices.azure.com", key: "k" };

function ctx(): AzureCallContext {
  return {
    service: "form_recognizer",
    operation: "placeholder",
    triggeredBy: "tester",
    triggeredByRole: "cto",
    requestBytes: 0,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveCreds.mockReturnValue(FAKE_CREDS);
});

/* ───────── mapTaxFields (pure) ───────── */

describe("mapTaxFields", () => {
  it("returns null when no documents are present", () => {
    expect(mapTaxFields({}, { Anything: "anything" })).toBeNull();
    expect(mapTaxFields({ analyzeResult: { documents: [] } }, { x: "x" })).toBeNull();
  });

  it("maps Azure W-2 fields to canonical ExtractedField[] with confidence", () => {
    const result = mapTaxFields(
      {
        analyzeResult: {
          content: "W-2 Wage and Tax Statement",
          documents: [
            {
              docType: "tax.us.w2",
              fields: {
                Employee_Name: { valueString: "Jane Doe", confidence: 0.97 },
                Employee_SocialSecurityNumber: { valueString: "XXX-XX-1234", confidence: 0.92 },
                Employer_Name: { valueString: "Acme Corp", confidence: 0.95 },
                Employer_IdNumber: { valueString: "12-3456789", confidence: 0.91 },
                WagesTipsAndOtherCompensation: { valueNumber: 75000.0, confidence: 0.96 },
                FederalIncomeTaxWithheld: { valueNumber: 12000.0, confidence: 0.94 },
                /* Unknown field — should be ignored. */
                BogusField: { valueString: "ignore me", confidence: 0.99 },
              },
            },
          ],
        },
      },
      {
        Employee_Name: "employee_name",
        Employee_SocialSecurityNumber: "employee_ssn",
        Employer_Name: "employer_name",
        Employer_IdNumber: "employer_ein",
        WagesTipsAndOtherCompensation: "wages",
        FederalIncomeTaxWithheld: "federal_income_tax_withheld",
      },
    );
    expect(result).toBeTruthy();
    const byName = Object.fromEntries(result!.fields.map((f) => [f.name, f]));
    expect(byName.employee_name.value).toBe("Jane Doe");
    expect(byName.employee_name.confidence).toBe(0.97);
    expect(byName.wages.value).toBe("75000");
    expect(byName.wages.rawValue).toBe(75000);
    expect(byName.federal_income_tax_withheld.rawValue).toBe(12000);
    /* Unknown Azure field stripped. */
    expect(byName.BogusField).toBeUndefined();
    expect(result!.rawText).toBe("W-2 Wage and Tax Statement");
  });

  it("maps Azure 1099 fields to canonical ExtractedField[]", () => {
    const result = mapTaxFields(
      {
        analyzeResult: {
          content: "1099-NEC",
          documents: [
            {
              docType: "tax.us.1099nec",
              fields: {
                Payer_Name: { valueString: "Globex LLC", confidence: 0.93 },
                Payer_TIN: { valueString: "98-7654321", confidence: 0.9 },
                Payee_Name: { valueString: "John Doe", confidence: 0.95 },
                Payee_TIN: { valueString: "XXX-XX-9876", confidence: 0.88 },
                NonemployeeCompensation: { valueNumber: 18000, confidence: 0.94 },
              },
            },
          ],
        },
      },
      {
        Payer_Name: "payer_name",
        Payer_TIN: "payer_tin",
        Payee_Name: "payee_name",
        Payee_TIN: "payee_tin",
        NonemployeeCompensation: "nonemployee_compensation",
      },
    );
    expect(result).toBeTruthy();
    const names = result!.fields.map((f) => f.name);
    expect(names).toContain("payer_name");
    expect(names).toContain("payee_name");
    expect(names).toContain("nonemployee_compensation");
    const nec = result!.fields.find((f) => f.name === "nonemployee_compensation");
    expect(nec?.value).toBe("18000");
    expect(nec?.rawValue).toBe(18000);
  });
});

/* ───────── isTaxFormConfigured ───────── */

describe("isTaxFormConfigured", () => {
  it("delegates to resolveAzureCreds for form_recognizer", () => {
    mockResolveCreds.mockReturnValueOnce(FAKE_CREDS);
    expect(isTaxFormConfigured()).toBe(true);
    mockResolveCreds.mockReturnValueOnce(null);
    expect(isTaxFormConfigured()).toBe(false);
  });
});

/* ───────── scanTaxW2 — happy path ───────── */

describe("scanTaxW2", () => {
  it("returns normalized fields from a happy-path W-2 extraction", async () => {
    mockPostAzure.mockResolvedValue({
      ok: true,
      value: { operationLocation: "https://op/123" },
      latencyMs: 5,
      httpStatus: 202,
    });
    mockPoll.mockResolvedValue({
      ok: true,
      value: {
        status: "succeeded",
        analyzeResult: {
          content: "W-2 wage statement contents",
          documents: [
            {
              docType: "tax.us.w2",
              fields: {
                Employee_Name: { valueString: "Jane Doe", confidence: 0.97 },
                WagesTipsAndOtherCompensation: { valueNumber: 75000, confidence: 0.95 },
              },
            },
          ],
        },
      },
      latencyMs: 200,
      httpStatus: 200,
    });

    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const result = await scanTaxW2(bytes, "application/pdf", ctx());

    expect(result.model).toBe("prebuilt-tax.us.w2");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.rawText).toBe("W-2 wage statement contents");
    const names = result.fields.map((f) => f.name);
    expect(names).toContain("employee_name");
    expect(names).toContain("wages");

    /* recordAzureCall fired with the W-2 operation tag. */
    expect(mockAudit).toHaveBeenCalled();
    const lastCall = mockAudit.mock.calls[mockAudit.mock.calls.length - 1];
    const passedCtx = lastCall[0] as AzureCallContext;
    expect(passedCtx.operation).toBe("prebuilt-tax.us.w2");
    expect(passedCtx.triggeredBy).toBe("tester");
  });
});

/* ───────── scanTax1099 — happy path ───────── */

describe("scanTax1099", () => {
  it("returns normalized fields from a happy-path 1099-NEC extraction", async () => {
    mockPostAzure.mockResolvedValue({
      ok: true,
      value: { operationLocation: "https://op/1099" },
      latencyMs: 4,
      httpStatus: 202,
    });
    mockPoll.mockResolvedValue({
      ok: true,
      value: {
        status: "succeeded",
        analyzeResult: {
          content: "1099-NEC nonemployee comp",
          documents: [
            {
              docType: "tax.us.1099nec",
              fields: {
                Payer_Name: { valueString: "Globex LLC", confidence: 0.94 },
                NonemployeeCompensation: { valueNumber: 12500, confidence: 0.93 },
              },
            },
          ],
        },
      },
      latencyMs: 250,
      httpStatus: 200,
    });

    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // jpeg magic
    const result = await scanTax1099(bytes, "image/jpeg", ctx());

    expect(result.model).toBe("prebuilt-tax.us.1099");
    const names = result.fields.map((f) => f.name);
    expect(names).toContain("payer_name");
    expect(names).toContain("nonemployee_compensation");
    expect(mockAudit).toHaveBeenCalled();
    const passedCtx = mockAudit.mock.calls[mockAudit.mock.calls.length - 1][0] as AzureCallContext;
    expect(passedCtx.operation).toBe("prebuilt-tax.us.1099");
  });
});

/* ───────── Guard rails ───────── */

describe("scanTaxW2 — guards", () => {
  it("rejects oversize bytes BEFORE any Azure call", async () => {
    const big = new Uint8Array(TAX_FORM_MAX_BYTES + 1);
    await expect(scanTaxW2(big, "application/pdf", ctx())).rejects.toBeInstanceOf(
      TaxFormVendorError,
    );
    expect(mockPostAzure).not.toHaveBeenCalled();
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it("rejects unsupported MIME type BEFORE any Azure call", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(scanTaxW2(bytes, "text/csv", ctx())).rejects.toBeInstanceOf(
      TaxFormVendorError,
    );
    expect(mockPostAzure).not.toHaveBeenCalled();
  });

  it("throws TaxFormNotConfiguredError when Azure creds are missing", async () => {
    mockResolveCreds.mockReturnValueOnce(null);
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(scanTaxW2(bytes, "application/pdf", ctx())).rejects.toBeInstanceOf(
      TaxFormNotConfiguredError,
    );
    expect(mockPostAzure).not.toHaveBeenCalled();
  });

  it("throws TaxFormVendorError on Azure polling timeout", async () => {
    mockPostAzure.mockResolvedValue({
      ok: true,
      value: { operationLocation: "https://op/timeout" },
      latencyMs: 5,
      httpStatus: 202,
    });
    mockPoll.mockResolvedValue({
      ok: false,
      error: { code: "polling_timeout", detail: "poll exceeded budget" },
      latencyMs: 30_000,
    });

    const bytes = new Uint8Array([1, 2, 3]);
    await expect(scanTaxW2(bytes, "application/pdf", ctx())).rejects.toMatchObject({
      name: "TaxFormVendorError",
      code: "polling_timeout",
    });
    /* Audit still recorded so cost tracking survives the failure. */
    expect(mockAudit).toHaveBeenCalled();
  });

  it("throws TaxFormVendorError with malformed_response equivalent when Azure returns no documents", async () => {
    mockPostAzure.mockResolvedValue({
      ok: true,
      value: { operationLocation: "https://op/empty" },
      latencyMs: 4,
      httpStatus: 202,
    });
    mockPoll.mockResolvedValue({
      ok: true,
      value: {
        status: "succeeded",
        analyzeResult: { documents: [] },
      },
      latencyMs: 100,
      httpStatus: 200,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(scanTaxW2(bytes, "application/pdf", ctx())).rejects.toMatchObject({
      name: "TaxFormVendorError",
      code: "no_document_detected",
    });
  });

  it("does NOT propagate audit failures — extractor still succeeds", async () => {
    mockPostAzure.mockResolvedValue({
      ok: true,
      value: { operationLocation: "https://op/audit-fail" },
      latencyMs: 4,
      httpStatus: 202,
    });
    mockPoll.mockResolvedValue({
      ok: true,
      value: {
        status: "succeeded",
        analyzeResult: {
          content: "",
          documents: [
            {
              fields: {
                Employee_Name: { valueString: "Jane Doe", confidence: 0.9 },
              },
            },
          ],
        },
      },
      latencyMs: 100,
      httpStatus: 200,
    });
    mockAudit.mockRejectedValueOnce(new Error("db down"));
    const bytes = new Uint8Array([1, 2, 3]);
    const out = await scanTaxW2(bytes, "application/pdf", ctx());
    expect(out.model).toBe("prebuilt-tax.us.w2");
  });
});

/* ───────── audit context ───────── */

describe("audit context", () => {
  it("invokes recordAzureCall with operation=prebuilt-tax.us.w2 and the caller's triggeredBy", async () => {
    mockPostAzure.mockResolvedValue({
      ok: true,
      value: { operationLocation: "https://op/audit-w2" },
      latencyMs: 4,
      httpStatus: 202,
    });
    mockPoll.mockResolvedValue({
      ok: true,
      value: {
        status: "succeeded",
        analyzeResult: {
          content: "audit",
          documents: [{ fields: { Employee_Name: { valueString: "X", confidence: 0.9 } } }],
        },
      },
      latencyMs: 100,
      httpStatus: 200,
    });
    const c: AzureCallContext = {
      service: "form_recognizer",
      operation: "placeholder",
      triggeredBy: "user-42",
      triggeredByRole: "manager",
      requestBytes: 3,
      documentId: "doc-77",
    };
    await scanTaxW2(new Uint8Array([1, 2, 3]), "application/pdf", c);
    const passed = mockAudit.mock.calls[0][0] as AzureCallContext;
    expect(passed.operation).toBe("prebuilt-tax.us.w2");
    expect(passed.triggeredBy).toBe("user-42");
    expect(passed.documentId).toBe("doc-77");
  });
});
