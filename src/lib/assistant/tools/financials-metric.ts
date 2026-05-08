/**
 * financials_metric tool — zero-token QuickBooks lookup.
 *
 * Maps a question keyword to a concrete QuickBooks metric and date
 * range, returns a natural-language answer. Connection-gated: when
 * QuickBooks isn't connected, returns null so the orchestrator can
 * fall back.
 */

import {
  getConnectionStatus,
  fetchProfitAndLoss,
  fetchAgedReceivables,
  fetchUnpaidInvoices,
  fetchBalanceSheet,
} from "@/lib/quickbooks";
import { resolveTimeframe } from "@/lib/assistant/timeframe";

export type FinancialMetric =
  | "revenue"
  | "net_profit"
  | "cash"
  | "unpaid_invoices"
  | "aged_receivables"
  | "unknown";

export function classifyMetric(text: string): FinancialMetric {
  const t = text.toLowerCase();
  if (/\b(cash|balance|bank)\b/.test(t)) return "cash";
  if (/\b(unpaid|overdue|invoice)s?\b/.test(t)) return "unpaid_invoices";
  if (/\b(aged? receivable|outstanding)s?\b/.test(t)) return "aged_receivables";
  if (/\b(net profit|profit)\b/.test(t)) return "net_profit";
  if (/\b(revenue|mrr|arr|income|sales)\b/.test(t)) return "revenue";
  return "unknown";
}

export interface FinancialsMetricResult {
  metric: FinancialMetric;
  value: number | null;
  timeframeLabel?: string;
  answer: string;
  source: "financials";
}

function fmt(v: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
}

export async function runFinancialsMetric(params: {
  question: string;
  timeframeToken?: string;
  nowMs?: number;
  /** Role of the user asking. Financial data is admin-only
   *  (ceo/cto) — every other role gets null and falls through to
   *  the generic RAG path, so they see no numbers. */
  userRole: string;
}): Promise<FinancialsMetricResult | null> {
  if (params.userRole !== "ceo" && params.userRole !== "cto" && params.userRole !== "evp") return null;
  const status = await getConnectionStatus().catch(() => null);
  if (!status || !status.connected) return null;

  const metric = classifyMetric(params.question);
  if (metric === "unknown") return null;

  const range = resolveTimeframe(params.timeframeToken, params.nowMs);
  const startIso = new Date(range.startMs).toISOString().split("T")[0];
  const endIso = new Date(range.endMs).toISOString().split("T")[0];

  if (metric === "revenue" || metric === "net_profit") {
    const pnl = await fetchProfitAndLoss(startIso, endIso).catch(() => null);
    if (!pnl) return null;
    const value = metric === "revenue" ? pnl.totalIncome : pnl.netIncome;
    return {
      metric,
      value,
      timeframeLabel: range.label,
      source: "financials",
      answer: `${metric === "revenue" ? "Revenue" : "Net profit"} for ${range.label}: ${fmt(value)}.`,
    };
  }

  if (metric === "cash") {
    const bs = await fetchBalanceSheet().catch(() => null);
    if (!bs) return null;
    // Balance sheet doesn't expose `cash` directly — pull it from the
    // assets list (line item name starts with "cash" or "bank").
    const cashLine = (bs.assets ?? []).find((a: { name: string }) =>
      /\b(cash|bank)\b/i.test(a.name),
    );
    const value = cashLine ? cashLine.amount : bs.totalAssets;
    return {
      metric,
      value,
      timeframeLabel: "now",
      source: "financials",
      answer: `Current cash position: ${fmt(value)}.`,
    };
  }

  if (metric === "unpaid_invoices") {
    const invoices = await fetchUnpaidInvoices().catch(() => []);
    const total = invoices.reduce((acc: number, i: { balance: number }) => acc + (i.balance || 0), 0);
    return {
      metric,
      value: total,
      timeframeLabel: "now",
      source: "financials",
      answer: `${invoices.length} unpaid invoice${invoices.length === 1 ? "" : "s"} totaling ${fmt(total)}.`,
    };
  }

  if (metric === "aged_receivables") {
    const aged = await fetchAgedReceivables().catch(() => null);
    if (!aged) return null;
    const total = (aged.current ?? 0) + (aged.days1to30 ?? 0) + (aged.days31to60 ?? 0) + (aged.days61to90 ?? 0) + (aged.over90 ?? 0);
    return {
      metric,
      value: total,
      timeframeLabel: "now",
      source: "financials",
      answer: `Aged receivables total ${fmt(total)} — ${fmt(aged.over90 ?? 0)} over 90 days.`,
    };
  }

  return null;
}
