import {
  matchScanInvoiceIntent,
  scanInvoiceTool,
} from "@/lib/assistant/tools/scan-invoice";

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

describe("matchScanInvoiceIntent", () => {
  it("matches the documented triggers", () => {
    for (const phrase of [
      "scan invoice", "log invoice", "process invoice",
      "ap invoice", "/invoice", "/ap", "invoice", "ap",
    ]) {
      expect(matchScanInvoiceIntent(phrase)).not.toBeNull();
    }
  });

  it("returns null for unrelated", () => {
    expect(matchScanInvoiceIntent("show my calendar")).toBeNull();
    expect(matchScanInvoiceIntent("")).toBeNull();
  });
});

describe("scanInvoiceTool.handler", () => {
  it("emits a scan_invoice widget spec", async () => {
    const out = await scanInvoiceTool.handler(
      {},
      { userId: "u", userRole: "cto", workflowId: "w-1" } as Parameters<typeof scanInvoiceTool.handler>[1],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.widget).toEqual({ kind: "scan_invoice" });
  });
});
