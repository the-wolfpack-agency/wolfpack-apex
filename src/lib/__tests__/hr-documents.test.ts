/**
 * HR Documents classifier + persistence unit tests.
 *
 * Tests every supported category against realistic excerpts from real
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
    expect(callSql).not.toContain("category = $1");
  });
});
