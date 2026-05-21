/**
 * scan-receipt assistant tool — intent matcher + handler.
 */

import {
  matchScanReceiptIntent,
  scanReceiptTool,
} from "@/lib/assistant/tools/scan-receipt";

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

describe("matchScanReceiptIntent", () => {
  it("matches the documented trigger phrases", () => {
    for (const phrase of [
      "scan receipt",
      "Scan a receipt",
      "scan document",
      "scan invoice",
      "upload receipt",
      "upload invoice",
      "/receipt",
      "/scan",
      "receipt",
      "invoice",
    ]) {
      expect(matchScanReceiptIntent(phrase)).not.toBeNull();
    }
  });

  it("returns null for unrelated phrases", () => {
    expect(matchScanReceiptIntent("show me my calendar")).toBeNull();
    expect(matchScanReceiptIntent("what's the weather")).toBeNull();
    expect(matchScanReceiptIntent("")).toBeNull();
  });

  it("prefills job_code from 'scan receipt for WOLFPACK-AUTO'", () => {
    const out = matchScanReceiptIntent("scan receipt for WOLFPACK-AUTO");
    expect(out).toEqual({ job_code: "WOLFPACK-AUTO" });
  });

  it("returns empty params when no code follows", () => {
    expect(matchScanReceiptIntent("scan receipt")).toEqual({});
  });
});

describe("scanReceiptTool.handler", () => {
  it("emits a scan_receipt widget spec on call", async () => {
    const out = await scanReceiptTool.handler(
      { job_code: "WPA-1" },
      { userId: "u", userRole: "cto", workflowId: "w-1" } as Parameters<typeof scanReceiptTool.handler>[1],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.widget).toEqual({ kind: "scan_receipt", jobCode: "WPA-1" });
  });
});
