import { matchScanHrDocIntent, scanHrDocTool } from "@/lib/assistant/tools/scan-hr-doc";

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

describe("matchScanHrDocIntent", () => {
  it("matches the documented triggers", () => {
    for (const p of [
      "scan license", "scan passport", "scan w-9", "scan w9", "scan i-9",
      "scan voided check", "scan direct deposit",
      "upload hr doc", "hr doc", "hr", "i9", "w9", "w-2", "license", "passport",
    ]) {
      expect(matchScanHrDocIntent(p)).not.toBeNull();
    }
  });

  it("returns null for unrelated phrases", () => {
    expect(matchScanHrDocIntent("scan invoice")).toBeNull();
    expect(matchScanHrDocIntent("scan receipt")).toBeNull();
    expect(matchScanHrDocIntent("")).toBeNull();
  });

  it("infers doc_type from the phrase", () => {
    expect(matchScanHrDocIntent("scan license")?.doc_type).toBe("license");
    expect(matchScanHrDocIntent("scan passport")?.doc_type).toBe("passport");
    expect(matchScanHrDocIntent("scan w-9")?.doc_type).toBe("w9");
    expect(matchScanHrDocIntent("scan voided check")?.doc_type).toBe("voided_check");
  });

  it("extracts employee email when present", () => {
    const r = matchScanHrDocIntent("scan w9 for jane.doe@example.com");
    expect(r?.doc_type).toBe("w9");
    expect(r?.employee_email).toBe("jane.doe@example.com");
  });
});

describe("scanHrDocTool.handler", () => {
  it("emits a scan_hr_doc widget spec with prefills", async () => {
    const out = await scanHrDocTool.handler(
      { employee_email: "jane@x.com", doc_type: "w9" },
      { userId: "u", userRole: "hr", workflowId: "w-1" } as Parameters<typeof scanHrDocTool.handler>[1],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.widget).toEqual({ kind: "scan_hr_doc", employeeEmail: "jane@x.com", docType: "w9" });
  });
});
