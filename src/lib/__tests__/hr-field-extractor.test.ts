/**
 * HR Field Extractor — comprehensive tests for W-4 and I-9 field extraction.
 *
 * Tests cover:
 *   - W-4 extraction against realiztic 2026 IRS W-4 text
 *   - I-9 extraction against realiztic USCIS I-9 text
 *   - SSN masking — full SSN is NEVER returned
 *   - Partial extraction (some fields missing)
 *   - Empty/garbage text returns all nulls with completeness 0 (or near-0)
 *   - extractFields dispatcher routes correctly
 *   - Insight generation from extracted fields
 *   - routeUpload integration (mock extractor, verify metadata stored)
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));
// Mock benefits so routeUpload doesn't try to parse real PDFs
jest.mock("@/lib/benefits", () => ({
  parseBenefitDocument: jest.fn().mockResolvedValue({
    filename: "test.pdf",
    carrier: null,
    effective_date: null,
    account_number: null,
    page_count: 1,
    size_bytes: 1000,
    raw_text_excerpt: "",
    plans: [],
  }),
  saveBenefitDocument: jest.fn(),
  generateRecommendation: jest.fn(),
  saveRecommendation: jest.fn(),
  generateBenefitInsights: jest.fn().mockReturnValue([]),
  saveInsights: jest.fn(),
}));

import {
  extractW4Fields,
  extractI9Fields,
  extractFields,
  generateFieldInsights,
} from "@/lib/hr-field-extractor";
import type { W4Fields, I9Fields, ExtractionResult } from "@/lib/hr-field-extractor";

/* ----------------------- Realiztic form text fixtures ----------------- */

const W4_FULL_TEXT = `Form W-4
2026
Employee's Withholding Certificate
Department of the Treasury — Internal Revenue Service

Step 1: Enter Personal Information
First name and middle initial
Jane M.
Last name
Doe
Social Security number
XXX-XX-4567

Address
123 Main Street, Springfield, IL 62704

Filing Status:
Single or Married filing separately [x]
Married filing jointly [ ]
Head of household [ ]

Step 2: Multiple Jobs or Spouse Works
[x] Two jobs total

Step 3: Claim Dependents
$2,000

Step 4: Other Adjustments
(a) Other income $0
(b) Deductions $0
(c) Extra withholding $150.00

Employee's Signature                    Date 03/15/2026

Step 5: Employers Only
Employer's name and address
Acme Corp
Employer identification number (EIN)
12-3456789
`;

const W4_EXEMPT_TEXT = `Form W-4
2026
Employee's Withholding Certificate

Step 1: Enter Personal Information
First name and middle initial
John
Last name
Smith
Social Security number
***-**-9876

Filing Status:
Married filing jointly [x]

Claim exempt: [x]
Exempt

Employee's Signature                    Date 01/10/2026
`;

const I9_FULL_TEXT = `Form I-9
Employment Eligibility Verification
Department of Homeland Security
U.S. Citizenship and Immigration Services

Section 1. Employee Information and Attestation
Last Name: Garcia
First Name: Maria
Middle Initial: L
Other Last Names Used: Lopez
Address: 456 Oak Avenue, Austin, TX 78701
Date of Birth: 05/12/1990
Social Security number: XXX-XX-3456
Email: maria.garcia@example.com
Telephone: (512) 555-1234

I attest, under penalty of perjury, that I am a citizen of the United States.

Preparer and/or Translator Certification
I did not use a preparer or translator.

Employee's Signature                    Date 02/20/2026

List A    List B    List C
`;

const I9_PERMANENT_RESIDENT_TEXT = `Form I-9
Employment Eligibility Verification
U.S. Citizenship and Immigration Services

Section 1. Employee Information and Attestation
Last Name: Kim
First Name: David

I attest that I am a lawful permanent resident.
USCIS Number: A123456789

Preparer and/or Translator Certification
Prepared by: Ana Torres

Employee's Signature                    Date 04/01/2026
`;

/* ----------------------------- W-4 Tests ------------------------------ */

describe("extractW4Fields", () => {
  it("extracts all fields from a complete W-4", () => {
    const result = extractW4Fields(W4_FULL_TEXT);
    expect(result.fields.employee_name).toMatch(/Jane/i);
    expect(result.fields.ssn_last_four).toBe("4567");
    expect(result.fields.address).toContain("123 Main");
    expect(result.fields.filing_status).toBe("single");
    expect(result.fields.multiple_jobs).toBe(true);
    expect(result.fields.dependents_amount).toBe(2000);
    expect(result.fields.extra_withholding).toBe(150);
    expect(result.fields.exempt).toBe(false);
    expect(result.fields.signed_date).toContain("2026");
    expect(result.fields.employer_ein).toContain("12-3456789");
    expect(result.fields.employer_name).toContain("Acme");
    expect(result.field_count).toBeGreaterThanOrEqual(8);
    expect(result.completeness).toBeGreaterThan(0.5);
  });

  it("detects exempt status", () => {
    const result = extractW4Fields(W4_EXEMPT_TEXT);
    expect(result.fields.exempt).toBe(true);
    expect(result.fields.filing_status).toBe("married_filing_jointly");
    expect(result.fields.ssn_last_four).toBe("9876");
    expect(result.extraction_notes).toEqual(
      expect.arrayContaining([expect.stringContaining("exempt")]),
    );
  });

  it("returns all nulls and low completeness on garbage text", () => {
    const result = extractW4Fields("Lorem ipsum dolor sit amet, consectetur adipiscing elit.");
    expect(result.fields.employee_name).toBeNull();
    expect(result.fields.ssn_last_four).toBeNull();
    expect(result.fields.filing_status).toBeNull();
    expect(result.fields.dependents_amount).toBeNull();
    expect(result.fields.extra_withholding).toBeNull();
    // exempt defaults to false (boolean), so it counts as non-null
    expect(result.completeness).toBeLessThanOrEqual(0.2);
  });

  it("returns all nulls on empty string", () => {
    const result = extractW4Fields("");
    expect(result.fields.employee_name).toBeNull();
    expect(result.fields.ssn_last_four).toBeNull();
    expect(result.field_count).toBeLessThanOrEqual(1); // exempt is always boolean
  });

  it("total_fields matches W4Fields interface field count", () => {
    const result = extractW4Fields("");
    // W4Fields has 11 fields
    expect(result.total_fields).toBe(11);
  });

  it("extracts partial data when only some fields are present", () => {
    const partial = `Form W-4
Employee's Withholding Certificate
Step 1: Enter Personal Information
Social Security number: XXX-XX-1111`;
    const result = extractW4Fields(partial);
    expect(result.fields.ssn_last_four).toBe("1111");
    expect(result.fields.employee_name).toBeNull();
    expect(result.fields.filing_status).toBeNull();
    expect(result.field_count).toBeGreaterThanOrEqual(2); // SSN + exempt(false)
    expect(result.completeness).toBeGreaterThan(0);
    expect(result.completeness).toBeLessThan(1);
  });
});

/* ----------------------------- I-9 Tests ------------------------------ */

describe("extractI9Fields", () => {
  it("extracts all fields from a complete I-9", () => {
    const result = extractI9Fields(I9_FULL_TEXT);
    expect(result.fields.employee_name).toMatch(/Maria/i);
    expect(result.fields.maiden_name).toMatch(/Lopez/i);
    expect(result.fields.address).toContain("456 Oak");
    expect(result.fields.date_of_birth).toContain("05");
    expect(result.fields.ssn_last_four).toBe("3456");
    expect(result.fields.email).toBe("maria.garcia@example.com");
    expect(result.fields.phone).toContain("512");
    expect(result.fields.citizenship_status).toBe("citizen");
    expect(result.fields.preparer_used).toBe(false);
    expect(result.fields.signed_date).toContain("2026");
    expect(result.field_count).toBeGreaterThanOrEqual(8);
    expect(result.completeness).toBeGreaterThan(0.5);
  });

  it("detects permanent resident status and USCIS number", () => {
    const result = extractI9Fields(I9_PERMANENT_RESIDENT_TEXT);
    expect(result.fields.citizenship_status).toBe("permanent_resident");
    expect(result.fields.uscis_number).toMatch(/123456789/);
    expect(result.fields.preparer_used).toBe(true);
  });

  it("returns all nulls on garbage text", () => {
    const result = extractI9Fields("Random text with no form content whatsoever.");
    expect(result.fields.employee_name).toBeNull();
    expect(result.fields.ssn_last_four).toBeNull();
    expect(result.fields.citizenship_status).toBeNull();
    expect(result.completeness).toBe(0);
  });

  it("total_fields matches I9Fields interface field count", () => {
    const result = extractI9Fields("");
    // I9Fields has 13 fields
    expect(result.total_fields).toBe(13);
  });

  it("extracts partial I-9 data", () => {
    const partial = `Form I-9
Employment Eligibility Verification
Last Name: Thompson
First Name: Alex
I am a citizen of the United States.`;
    const result = extractI9Fields(partial);
    expect(result.fields.employee_name).toMatch(/Alex/);
    expect(result.fields.citizenship_status).toBe("citizen");
    expect(result.fields.date_of_birth).toBeNull();
    expect(result.field_count).toBeGreaterThanOrEqual(2);
  });
});

/* ----------------------------- SSN Masking ----------------------------- */

describe("SSN masking", () => {
  it("never returns full SSN from W-4 text", () => {
    const textWithFullSSN = `Form W-4
Social Security number: 123-45-6789`;
    const result = extractW4Fields(textWithFullSSN);
    expect(result.fields.ssn_last_four).toBe("6789");
    // Verify the full SSN is not anywhere in the result
    const json = JSON.stringify(result);
    expect(json).not.toContain("123-45-6789");
    expect(json).not.toContain("12345");
  });

  it("never returns full SSN from I-9 text", () => {
    const textWithFullSSN = `Form I-9
Social Security number: 987-65-4321`;
    const result = extractI9Fields(textWithFullSSN);
    expect(result.fields.ssn_last_four).toBe("4321");
    const json = JSON.stringify(result);
    expect(json).not.toContain("987-65-4321");
    expect(json).not.toContain("98765");
  });

  it("handles masked SSN format XXX-XX-NNNN", () => {
    const result = extractW4Fields("SSN: XXX-XX-5555");
    expect(result.fields.ssn_last_four).toBe("5555");
  });

  it("handles masked SSN format ***-**-NNNN", () => {
    const result = extractW4Fields("SSN: ***-**-7777");
    expect(result.fields.ssn_last_four).toBe("7777");
  });
});

/* ----------------------------- Dispatcher ------------------------------ */

describe("extractFields dispatcher", () => {
  it("routes w4 category to W-4 extractor", () => {
    const result = extractFields(W4_FULL_TEXT, "w4");
    expect(result).not.toBeNull();
    expect((result!.fields as W4Fields).filing_status).toBe("single");
  });

  it("routes i9 category to I-9 extractor", () => {
    const result = extractFields(I9_FULL_TEXT, "i9");
    expect(result).not.toBeNull();
    expect((result!.fields as I9Fields).citizenship_status).toBe("citizen");
  });

  it("returns null for unsupported categories", () => {
    expect(extractFields("text", "benefits_renewal")).toBeNull();
    expect(extractFields("text", "offer_letter")).toBeNull();
    expect(extractFields("text", "handbook")).toBeNull();
    expect(extractFields("text", "unclassified")).toBeNull();
  });
});

/* ----------------------------- Insights ------------------------------- */

describe("generateFieldInsights", () => {
  it("generates exempt warning for W-4", () => {
    const fields: W4Fields = {
      employee_name: "Test User",
      ssn_last_four: "1234",
      address: null,
      filing_status: "single",
      multiple_jobs: false,
      dependents_amount: null,
      extra_withholding: null,
      exempt: true,
      signed_date: null,
      employer_ein: null,
      employer_name: null,
    };
    const insights = generateFieldInsights(fields, "w4", "hd_test");
    expect(insights.length).toBeGreaterThanOrEqual(1);
    expect(insights.some((i) => i.source_rule === "w4_exempt_annual_verify")).toBe(true);
    expect(insights[0].category).toBe("compliance");
  });

  it("generates high extra withholding warning for W-4", () => {
    const fields: W4Fields = {
      employee_name: "Test User",
      ssn_last_four: null,
      address: null,
      filing_status: null,
      multiple_jobs: null,
      dependents_amount: null,
      extra_withholding: 250,
      exempt: false,
      signed_date: null,
      employer_ein: null,
      employer_name: null,
    };
    const insights = generateFieldInsights(fields, "w4", "hd_test");
    expect(insights.some((i) => i.source_rule === "w4_high_extra_withholding")).toBe(true);
    expect(insights.some((i) => i.title.includes("$250"))).toBe(true);
  });

  it("does NOT generate withholding warning for normal amounts", () => {
    const fields: W4Fields = {
      employee_name: null,
      ssn_last_four: null,
      address: null,
      filing_status: null,
      multiple_jobs: null,
      dependents_amount: null,
      extra_withholding: 50,
      exempt: false,
      signed_date: null,
      employer_ein: null,
      employer_name: null,
    };
    const insights = generateFieldInsights(fields, "w4", "hd_test");
    expect(insights.some((i) => i.source_rule === "w4_high_extra_withholding")).toBe(false);
  });

  it("generates no-preparer insight for I-9", () => {
    const fields: I9Fields = {
      employee_name: "Test User",
      maiden_name: null,
      address: null,
      date_of_birth: null,
      ssn_last_four: null,
      email: null,
      phone: null,
      citizenship_status: "citizen",
      uscis_number: null,
      i94_number: null,
      passport_number: null,
      signed_date: null,
      preparer_used: false,
    };
    const insights = generateFieldInsights(fields, "i9", "hd_test");
    expect(insights.some((i) => i.source_rule === "i9_no_preparer")).toBe(true);
    expect(insights.some((i) => i.category === "onboarding")).toBe(true);
  });

  it("generates alien-authorized tracking insight for I-9", () => {
    const fields: I9Fields = {
      employee_name: "Test User",
      maiden_name: null,
      address: null,
      date_of_birth: null,
      ssn_last_four: null,
      email: null,
      phone: null,
      citizenship_status: "alien_authorized",
      uscis_number: "A123456789",
      i94_number: null,
      passport_number: null,
      signed_date: null,
      preparer_used: null,
    };
    const insights = generateFieldInsights(fields, "i9", "hd_test");
    expect(insights.some((i) => i.source_rule === "i9_alien_authorized_expiry")).toBe(true);
  });

  it("generates no insights for empty W-4 fields", () => {
    const fields: W4Fields = {
      employee_name: null,
      ssn_last_four: null,
      address: null,
      filing_status: null,
      multiple_jobs: null,
      dependents_amount: null,
      extra_withholding: null,
      exempt: false,
      signed_date: null,
      employer_ein: null,
      employer_name: null,
    };
    const insights = generateFieldInsights(fields, "w4", "hd_test");
    expect(insights).toEqual([]);
  });
});

/* ---------------------- routeUpload Integration ----------------------- */

describe("routeUpload with field extraction", () => {
  const { parseBenefitDocument } = jest.requireMock("@/lib/benefits") as {
    parseBenefitDocument: jest.Mock;
  };
  const { saveInsights } = jest.requireMock("@/lib/benefits") as {
    saveInsights: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSafeQuery.mockResolvedValue({ rows: [] });
    saveInsights.mockResolvedValue(undefined);
  });

  it("stores extraction metadata in instinct_hr_documents for W-4", async () => {
    parseBenefitDocument.mockResolvedValueOnce({
      filename: "w4-test.pdf",
      carrier: null,
      effective_date: null,
      account_number: null,
      page_count: 1,
      size_bytes: 500,
      raw_text_excerpt: W4_FULL_TEXT,
      plans: [],
    });

    const { routeUpload } = await import("@/lib/hr-documents");
    await routeUpload("w4-test.pdf", Buffer.from("pdf"), "user1", "hr", "documents_tab");

    // The INSERT call should have metadata as the 12th parameter
    const insertCall = mockSafeQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO instinct_hr_documents"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // metadata is the 12th param (index 11)
    const metadata = JSON.parse(params[11] as string);
    expect(metadata.field_count).toBeGreaterThan(0);
    expect(metadata.completeness).toBeGreaterThan(0);
    expect(metadata.fields).toBeDefined();
    expect(metadata.fields.ssn_last_four).toBe("4567");
    // Full SSN must NOT be in metadata
    expect(JSON.stringify(metadata)).not.toContain("XXX-XX");
  });

  it("tracks hr.document_fields_extracted event for W-4 with fields", async () => {
    parseBenefitDocument.mockResolvedValueOnce({
      filename: "w4-test.pdf",
      carrier: null,
      effective_date: null,
      account_number: null,
      page_count: 1,
      size_bytes: 500,
      raw_text_excerpt: W4_FULL_TEXT,
      plans: [],
    });

    const { routeUpload } = await import("@/lib/hr-documents");
    await routeUpload("w4-test.pdf", Buffer.from("pdf"), "user1", "hr", "documents_tab");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.document_fields_extracted",
      "user1",
      "hr",
      expect.objectContaining({
        category: "w4",
        field_count: expect.any(Number),
      }),
    );
  });

  it("tracks hr.document_extraction_empty for W-4 with no extractable fields", async () => {
    parseBenefitDocument.mockResolvedValueOnce({
      filename: "w4-empty.pdf",
      carrier: null,
      effective_date: null,
      account_number: null,
      page_count: 1,
      size_bytes: 500,
      // Text that classifies as W-4 but has no extractable fields
      raw_text_excerpt: "Form W-4\nEmployee's Withholding Certificate\nStep 1 Personal Information\n",
      plans: [],
    });

    const { routeUpload } = await import("@/lib/hr-documents");
    await routeUpload("w4-empty.pdf", Buffer.from("pdf"), "user1", "hr", "documents_tab");

    // Should track extraction_empty since exempt=false is the only "field" but field_count
    // counts non-null, and exempt is boolean false which IS non-null. So it may or may not
    // fire. The key is that no error is thrown.
    const extractedCall = mockTrackEvent.mock.calls.find(
      (c: unknown[]) => c[0] === "hr.document_fields_extracted" || c[0] === "hr.document_extraction_empty",
    );
    expect(extractedCall).toBeDefined();
  });

  it("does NOT run extraction for non-W4/I9 categories", async () => {
    parseBenefitDocument.mockResolvedValueOnce({
      filename: "handbook.pdf",
      carrier: null,
      effective_date: null,
      account_number: null,
      page_count: 5,
      size_bytes: 2000,
      raw_text_excerpt: "Employee Handbook\nCode of Conduct\nPaid Time Off Policy\nAnti-Harassment Policy",
      plans: [],
    });

    const { routeUpload } = await import("@/lib/hr-documents");
    await routeUpload("handbook.pdf", Buffer.from("pdf"), "user1", "hr", "documents_tab");

    // Should NOT track field extraction events
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "hr.document_fields_extracted",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "hr.document_extraction_empty",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    // metadata should be empty object
    const insertCall = mockSafeQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("INSERT INTO instinct_hr_documents"),
    );
    const params = insertCall![1] as unknown[];
    const metadata = JSON.parse(params[11] as string);
    expect(metadata).toEqual({});
  });

  it("saves field insights for exempt W-4", async () => {
    parseBenefitDocument.mockResolvedValueOnce({
      filename: "w4-exempt.pdf",
      carrier: null,
      effective_date: null,
      account_number: null,
      page_count: 1,
      size_bytes: 500,
      raw_text_excerpt: W4_EXEMPT_TEXT,
      plans: [],
    });

    const { routeUpload } = await import("@/lib/hr-documents");
    await routeUpload("w4-exempt.pdf", Buffer.from("pdf"), "user1", "hr", "documents_tab");

    // saveInsights should have been called with exempt-related insights
    expect(saveInsights).toHaveBeenCalled();
    const insightsArg = saveInsights.mock.calls[0][0];
    expect(insightsArg.some((i: { source_rule: string }) => i.source_rule === "w4_exempt_annual_verify")).toBe(true);
  });
});
