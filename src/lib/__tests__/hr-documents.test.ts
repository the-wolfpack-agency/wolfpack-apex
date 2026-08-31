/**
 * HR Documents classifier + persistence unit tests.
 *
 * Tests every supported category against realiztic excerpts from real
 * IRS / USCIS / BCBS forms. Locks the classifier behavior so a future
 * weight tweak can't silently regress an existing match.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  classifyDocument,
  HR_CATEGORIES,
  recategorizeDocument,
  linkDocumentToEmployee,
  unlinkDocumentFromEmployee,
  deleteHrDocument,
  listHrDocuments,
} from "@/lib/hr-documents";

describe("classifyDocument", () => {
  it("classifies a 2026 W-4 form", () => {
    const text = `Form W-4
2026
Employee's Withholding Certificate
Department of the Treasury
Internal Revenue Service
Step 1: Enter Personal Information
Multiple Jobs Worksheet`;
    const r = classifyDocument(text);
    expect(r.category).toBe("w4");
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("classifies an I-9 form", () => {
    const text = `Form I-9
Employment Eligibility Verification
Department of Homeland Security
U.S. Citizenship and Immigration Services
USCIS Form I-9
List A   List B    List C`;
    const r = classifyDocument(text);
    expect(r.category).toBe("i9");
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it("classifies a BCBS group enrollment / change form (per-employee)", () => {
    const text = `Group Enrollment Application | Change Form
Blue Cross and Blue Shield of Texas
ENROLLMENT APPLICATION/CHANGE FORM
SECTION 1 — ENROLLMENT EVENTS
New Enrollee   Add Dependent   Open Enrollment
Special Enrollment Event
SECTION 4 — COVERAGE OPTIONS
PCP Selection is required for Blue Advantage, Blue Premier and Blue Essentials plans
Primary Care Physician
SECTION 8 — DECLINATION OF COVERAGE
SECTION 5 — DISABLED DEPENDENT
Cancel Enrollee   Add Dependent`;
    const r = classifyDocument(text);
    expect(r.category).toBe("benefits_enrollment");
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it("classifies the Spanish BCBS enrollment form via the Solicitud de cobertura phrase", () => {
    const text = `Solicitud de cobertura | Solicitud de cambios
Blue Cross and Blue Shield of Texas
SECCIÓN 1: MOTIVOS DE SOLICITUD
Nuevo asegurado   Agregar derechohabiente
SECCIÓN 8: RENUNCIA A LA COBERTURA`;
    const r = classifyDocument(text);
    expect(r.category).toBe("benefits_enrollment");
  });

  it("benefits renewal exhibit and benefits enrollment do NOT collide", () => {
    // The renewal exhibit has plan IDs + Total Monthly Medical Cost,
    // the enrollment form has Group Enrollment Application + Section 8.
    // Both contain "Blue Cross" — confidence routing must distinguish.
    const renewalText = `Medical Plans
Renewal Effective Date: Dec 1, 2025
Total Monthly Medical Cost - Age Rates
Blue Choice PPO Network
P9M1CHC $1050 Deductible Out-of-Pocket Max`;
    const enrollmentText = `Group Enrollment Application | Change Form
Blue Cross and Blue Shield of Texas
SECTION 1 — ENROLLMENT EVENTS
New Enrollee   Open Enrollment
SECTION 8 — DECLINATION OF COVERAGE`;
    expect(classifyDocument(renewalText).category).toBe("benefits_renewal");
    expect(classifyDocument(enrollmentText).category).toBe("benefits_enrollment");
  });

  it("classifies a BCBS benefits renewal", () => {
    const text = `THE WOLFPACK AGENCY LLC
Renewal Effective Date: Dec 1, 2025
Medical Plans
Plan ID
Blue Choice PPO Network
PPO Plans
P9M1CHC $1050 Deductible $6300 Out-of-Pocket Max`;
    const r = classifyDocument(text);
    expect(r.category).toBe("benefits_renewal");
    expect(r.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it("classifies an offer letter", () => {
    const text = `Dear John,
We are pleased to extend an Offer of Employment.
Your annual base salary will be $90,000 per year.
This is at-will employment.
Your start date is January 15, 2026.`;
    const r = classifyDocument(text);
    expect(r.category).toBe("offer_letter");
  });

  it("classifies an employee handbook", () => {
    const text = `THE WOLFPACK AGENCY
Employee Handbook
Code of Conduct
Paid Time Off Policy
Anti-Harassment Policy`;
    const r = classifyDocument(text);
    expect(r.category).toBe("handbook");
  });

  it("returns unclassified on empty text", () => {
    const r = classifyDocument("");
    expect(r.category).toBe("unclassified");
    expect(r.confidence).toBe(0);
  });

  it("returns unclassified on random non-HR text", () => {
    const r = classifyDocument("This is just a random sentence about cats.");
    expect(r.category).toBe("unclassified");
    expect(r.confidence).toBeLessThan(0.4);
  });

  it("HR_CATEGORIES contains every category referenced", () => {
    expect(HR_CATEGORIES).toEqual(
      expect.arrayContaining(["w4", "i9", "benefits_renewal", "offer_letter", "handbook", "unclassified"]),
    );
  });
});

describe("hr-documents persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSafeQuery.mockResolvedValue({ rows: [] });
  });

  it("recategorizeDocument fires hr.document_recategorized on success", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "hd_1", filename: "x.pdf", category: "w4", classification_confidence: 0.8,
        classification_reasons: [], size_bytes: 1, page_count: 1, employee_id: null,
        benefit_document_id: null, raw_text_excerpt: "", uploaded_by: "u",
        uploaded_at: "x", updated_at: "x", status: "active", mime_type: null,
      }],
    });
    const r = await recategorizeDocument("hd_1", "i9", "u_alicia", "hr");
    expect(r).not.toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.document_recategorized",
      "u_alicia",
      "hr",
      expect.objectContaining({ document_id: "hd_1", new_category: "i9" }),
    );
  });

  it("recategorizeDocument returns null on missing doc and emits no event", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const r = await recategorizeDocument("hd_x", "i9", "u", "hr");
    expect(r).toBeNull();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it("linkDocumentToEmployee fires hr.document_linked_to_employee", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "hd_1", filename: "x.pdf", category: "w4", classification_confidence: 0.8,
        classification_reasons: [], size_bytes: 1, page_count: 1, employee_id: "emp_1",
        benefit_document_id: null, raw_text_excerpt: "", uploaded_by: "u",
        uploaded_at: "x", updated_at: "x", status: "active", mime_type: null,
      }],
    });
    await linkDocumentToEmployee("hd_1", "emp_1", "u", "hr");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.document_linked_to_employee",
      "u",
      "hr",
      expect.objectContaining({ document_id: "hd_1", employee_id: "emp_1" }),
    );
  });

  it("deleteHrDocument fires hr.document_deleted on success", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "hd_1" }] });
    expect(await deleteHrDocument("hd_1", "u", "hr")).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.document_deleted",
      "u",
      "hr",
      expect.objectContaining({ document_id: "hd_1" }),
    );
  });

  it("deleteHrDocument returns false on missing doc", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await deleteHrDocument("hd_x", "u", "hr")).toBe(false);
  });

  it("listHrDocuments with category filter passes the right WHERE clause", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listHrDocuments({ category: "w4" });
    const callSql = mockSafeQuery.mock.calls[0][0] as string;
    expect(callSql).toContain("category = $1");
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["w4"]);
  });

  it("listHrDocuments without filter omits the WHERE clause", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listHrDocuments();
    const callSql = mockSafeQuery.mock.calls[0][0] as string;
    expect(callSql).not.toContain("category = $");
    expect(callSql).not.toContain("employee_id = $");
  });

  it("unlinkDocumentFromEmployee sets employee_id to NULL and fires unlink event", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{
        id: "hd_1", filename: "x.pdf", category: "w4", classification_confidence: 0.8,
        classification_reasons: [], size_bytes: 1, page_count: 1, employee_id: null,
        benefit_document_id: null, raw_text_excerpt: "", uploaded_by: "u",
        uploaded_at: "x", updated_at: "x", status: "active", mime_type: null,
      }],
    });
    const r = await unlinkDocumentFromEmployee("hd_1", "u_alicia", "hr");
    expect(r).not.toBeNull();
    expect(r!.employee_id).toBeNull();
    const callSql = mockSafeQuery.mock.calls[0][0] as string;
    expect(callSql).toContain("employee_id = NULL");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.document_unlinked_from_employee",
      "u_alicia",
      "hr",
      expect.objectContaining({ document_id: "hd_1" }),
    );
  });

  it("unlinkDocumentFromEmployee returns null on missing doc and emits no event", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const r = await unlinkDocumentFromEmployee("hd_x", "u", "hr");
    expect(r).toBeNull();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it("listHrDocuments with employee_id filter passes the right WHERE clause", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listHrDocuments({ employee_id: "emp_1" });
    const callSql = mockSafeQuery.mock.calls[0][0] as string;
    expect(callSql).toContain("employee_id = $");
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["emp_1"]);
  });

  it("listHrDocuments with both category and employee_id filters passes both", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listHrDocuments({ category: "w4", employee_id: "emp_1" });
    const callSql = mockSafeQuery.mock.calls[0][0] as string;
    expect(callSql).toContain("category = $1");
    expect(callSql).toContain("employee_id = $2");
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["w4", "emp_1"]);
  });
});
