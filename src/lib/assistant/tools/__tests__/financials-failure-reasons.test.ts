/**
 * Say what actually happened, not that the user phrased it wrong.
 *
 * Reported from the live assistant on 2026-08-26:
 *
 *   "what's our MRR"            -> I couldn't find a matching financial metric.
 *                                  Try a more specific question like
 *                                  'what was our MRR last month?'
 *   "what was our MRR last month" -> the identical message
 *
 * The suggested rephrasing WAS the question that had just failed. Following
 * the advice spent the person's second attempt on the same error.
 *
 * And the wording was never the problem. classifyMetric matches "mrr" to
 * revenue on the first try. The null came from getConnectionStatus: QuickBooks
 * has never been connected, and production holds zero token rows. The product
 * understood the question, discovered its own missing integration, and blamed
 * the person asking.
 */
const mockStatus = jest.fn();
const mockPnl = jest.fn();
jest.mock("@/lib/quickbooks", () => ({
  getConnectionStatus: () => mockStatus(),
  fetchProfitAndLoss: (...a: unknown[]) => mockPnl(...a),
  fetchBalanceSheet: jest.fn(),
  fetchUnpaidInvoices: jest.fn(async () => []),
  fetchAgedReceivables: jest.fn(),
}));

import {
  runFinancialsMetricOutcome,
  classifyMetric,
} from "@/lib/assistant/tools/financials-metric";

beforeEach(() => {
  jest.clearAllMocks();
  mockStatus.mockResolvedValue({ connected: true });
});

describe("the question was understood all along", () => {
  it.each(["what's our MRR", "what was our MRR last month", "how is revenue doing?"])(
    "classifies %s as revenue",
    (q) => {
      expect(classifyMetric(q)).toBe("revenue");
    },
  );
});

describe("why there was no number", () => {
  /* THE REPORTED BUG. Understood, and unanswerable for a reason that has
     nothing to do with wording. */
  it("reports a disconnected accounting system as exactly that", async () => {
    mockStatus.mockResolvedValue({ connected: false });
    const out = await runFinancialsMetricOutcome({ question: "what's our MRR", userRole: "cto" });
    expect(out).toEqual({ ok: false, reason: "not_connected" });
  });

  it("separates a connected system with no data from a disconnected one", async () => {
    mockPnl.mockResolvedValue(null);
    const out = await runFinancialsMetricOutcome({
      question: "what was our MRR last month",
      userRole: "cto",
    });
    expect(out).toEqual({ ok: false, reason: "no_data" });
  });

  it("separates a role refusal from both", async () => {
    const out = await runFinancialsMetricOutcome({ question: "what's our MRR", userRole: "dealer" });
    expect(out).toEqual({ ok: false, reason: "not_authorised" });
  });

  /* The ONLY case where rephrasing is genuinely the fix. */
  it("reports an unrecognised metric as unknown", async () => {
    const out = await runFinancialsMetricOutcome({
      question: "what is our gross margin per cohort?",
      userRole: "cto",
    });
    expect(out).toEqual({ ok: false, reason: "unknown_metric" });
  });

  it("answers when it can", async () => {
    mockPnl.mockResolvedValue({ totalIncome: 42000, netIncome: 12000 });
    const out = await runFinancialsMetricOutcome({ question: "what's our MRR", userRole: "cto" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.value).toBe(42000);
  });
});

/**
 * The sentence a person reads.
 *
 * The rule this pins: a message may only tell somebody to rephrase when
 * rephrasing is genuinely the fix. Suggesting one for a disconnected
 * accounting system sends them round a loop they cannot escape by trying
 * harder, and it spends their second attempt as well as their first.
 */
import { getFinancialsMetricTool } from "@/lib/assistant/tools/get-financials-metric-tool";

async function answerFor(question: string, role = "cto"): Promise<string> {
  const res = await getFinancialsMetricTool.handler(
    { question, timeframe: undefined },
    { userId: "u", userRole: role, workspaceId: "default" } as never,
  );
  return res.ok ? (res.answer ?? "") : "";
}

describe("what the user is told", () => {
  it("names the missing connection instead of blaming the wording", async () => {
    mockStatus.mockResolvedValue({ connected: false });
    const answer = await answerFor("what's our MRR");
    expect(answer).toMatch(/not connected/i);
    expect(answer).toMatch(/QuickBooks/);
  });

  /* THE LOOP, ASSERTED SHUT. The old message suggested "what was our MRR last
     month", which was the next thing the user typed, and it failed the same
     way. No message may suggest a rephrasing unless wording is the fault. */
  it.each([
    ["a disconnected system", { connected: false }, "what's our MRR"],
    ["an empty period", { connected: true }, "what was our MRR last month"],
  ])("never asks the user to rephrase for %s", async (_label, status, question) => {
    mockStatus.mockResolvedValue(status);
    mockPnl.mockResolvedValue(null);
    const answer = await answerFor(question);
    expect(answer).not.toMatch(/more specific/i);
    expect(answer).not.toMatch(/rephrase/i);
    /* And above all, never quote back a question that just failed. */
    expect(answer.toLowerCase()).not.toContain("what was our mrr last month");
  });

  it("does ask, when the wording genuinely is the problem", async () => {
    const answer = await answerFor("what is our gross margin per cohort?");
    /* Says what it CAN answer, rather than asking for "more specific". A list
       is actionable; an adjective is not. */
    expect(answer).toMatch(/revenue/i);
    expect(answer).toMatch(/unpaid invoices/i);
  });
});
