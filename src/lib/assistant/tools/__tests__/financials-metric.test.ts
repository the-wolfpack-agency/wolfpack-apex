 
const mockGetConnectionStatus = jest.fn();
const mockFetchPnL = jest.fn();
const mockFetchBalance = jest.fn();
const mockFetchUnpaid = jest.fn();
const mockFetchAged = jest.fn();

jest.mock("@/lib/quickbooks", () => ({
  getConnectionStatus: (...a: any[]) => mockGetConnectionStatus(...a),
  fetchProfitAndLoss: (...a: any[]) => mockFetchPnL(...a),
  fetchBalanceSheet: (...a: any[]) => mockFetchBalance(...a),
  fetchUnpaidInvoices: (...a: any[]) => mockFetchUnpaid(...a),
  fetchAgedReceivables: (...a: any[]) => mockFetchAged(...a),
  fetchAgedPayables: (...a: any[]) => null,
}));

import { runFinancialsMetric } from "@/lib/assistant/tools/financials-metric";

beforeEach(() => {
  mockGetConnectionStatus.mockReset();
  mockFetchPnL.mockReset();
  mockFetchBalance.mockReset();
  mockFetchUnpaid.mockReset();
  mockFetchAged.mockReset();
});

describe("runFinancialsMetric — role gate", () => {
  test.each(["dev", "sales", "ops", "hr", "designer"])(
    "non-admin role '%s' gets null without hitting QB",
    async (role) => {
      const out = await runFinancialsMetric({
        question: "what's our MRR?",
        userRole: role,
      });
      expect(out).toBeNull();
      expect(mockGetConnectionStatus).not.toHaveBeenCalled();
    },
  );

  test("ceo can query", async () => {
    mockGetConnectionStatus.mockResolvedValue({ connected: true });
    mockFetchPnL.mockResolvedValue({ totalIncome: 250_000, netIncome: 80_000 });
    const out = await runFinancialsMetric({
      question: "what's our revenue this quarter?",
      userRole: "ceo",
      timeframeToken: "this_quarter",
    });
    expect(out?.metric).toBe("revenue");
    expect(out?.value).toBe(250_000);
  });

  test("cto can query", async () => {
    mockGetConnectionStatus.mockResolvedValue({ connected: true });
    mockFetchBalance.mockResolvedValue({
      asOfDate: "2026-04-21",
      totalAssets: 2_000_000,
      totalLiabilities: 500_000,
      totalEquity: 1_500_000,
      assets: [{ name: "Cash and equivalents", amount: 1_250_000 }],
      liabilities: [],
      equity: [],
    });
    const out = await runFinancialsMetric({
      question: "how much cash do we have?",
      userRole: "cto",
    });
    expect(out?.metric).toBe("cash");
    expect(out?.value).toBe(1_250_000);
    expect(out?.answer).toContain("$1,250,000");
  });
});

describe("runFinancialsMetric — connection gate + metrics", () => {
  test("returns null when QuickBooks isn't connected", async () => {
    mockGetConnectionStatus.mockResolvedValue({ connected: false });
    expect(
      await runFinancialsMetric({ question: "mrr?", userRole: "ceo" }),
    ).toBeNull();
  });

  test("unpaid_invoices sums balances + counts", async () => {
    mockGetConnectionStatus.mockResolvedValue({ connected: true });
    mockFetchUnpaid.mockResolvedValue([{ balance: 1000 }, { balance: 500 }]);
    const out = await runFinancialsMetric({
      question: "how many unpaid invoices?",
      userRole: "ceo",
    });
    expect(out?.value).toBe(1500);
    expect(out?.answer).toContain("2 unpaid");
  });

  test("aged receivables over-90 surfaces in the answer", async () => {
    mockGetConnectionStatus.mockResolvedValue({ connected: true });
    mockFetchAged.mockResolvedValue({ current: 500, days1to30: 300, days31to60: 0, days61to90: 0, over90: 200 });
    const out = await runFinancialsMetric({
      question: "what are our aged receivables?",
      userRole: "cto",
    });
    expect(out?.value).toBe(1000);
    expect(out?.answer).toContain("over 90");
  });

  test("unknown-metric question returns null", async () => {
    mockGetConnectionStatus.mockResolvedValue({ connected: true });
    const out = await runFinancialsMetric({
      question: "how am I doing?",
      userRole: "ceo",
    });
    expect(out).toBeNull();
  });
});
