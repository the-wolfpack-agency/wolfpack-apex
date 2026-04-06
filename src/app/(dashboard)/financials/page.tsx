"use client";

import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types (match quickbooks.ts exports)
// ---------------------------------------------------------------------------

interface ProfitAndLoss {
  startDate: string;
  endDate: string;
  totalIncome: number;
  totalExpenses: number;
  netIncome: number;
  incomeCategories: { name: string; amount: number }[];
  expenseCategories: { name: string; amount: number }[];
}

interface BalanceSheet {
  asOfDate: string;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  assets: { name: string; amount: number }[];
  liabilities: { name: string; amount: number }[];
  equity: { name: string; amount: number }[];
}

interface CashFlow {
  startDate: string;
  endDate: string;
  operatingActivities: number;
  investingActivities: number;
  financingActivities: number;
  netCashChange: number;
}

interface AgedSummary {
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  over90: number;
  total: number;
  details: { name: string; current: number; days1to30: number; days31to60: number; days61to90: number; over90: number; total: number }[];
}

interface Invoice {
  id: string;
  customerName: string;
  amount: number;
  balance: number;
  dueDate: string;
  status: string;
}

interface Payment {
  id: string;
  customerName: string;
  amount: number;
  date: string;
  method: string;
}

interface CompanyInfo {
  companyName: string;
  legalName: string;
  fiscalYearStart: string;
  country: string;
  email: string;
  phone: string;
}

interface FinancialData {
  connection: { connected: boolean; mode: "live" | "shadow"; companyName: string | null };
  companyInfo: CompanyInfo | null;
  profitAndLoss: ProfitAndLoss | null;
  balanceSheet: BalanceSheet | null;
  cashFlow: CashFlow | null;
  agedReceivables: AgedSummary | null;
  agedPayables: AgedSummary | null;
  unpaidInvoices: Invoice[];
  recentPayments: Payment[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function fmtDate(d: string): string {
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return d;
  }
}

function isOverdue(dueDate: string): boolean {
  return new Date(dueDate) < new Date();
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg border p-5"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      <h2 className="text-sm font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function MetricRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b last:border-b-0" style={{ borderColor: "var(--wp-dark-border)" }}>
      <span className="text-sm" style={{ color: "var(--wp-text-dim)" }}>{label}</span>
      <span className="text-sm font-mono font-medium" style={{ color: color || "var(--wp-text)" }}>{value}</span>
    </div>
  );
}

function AgingBar({ current, d30, d60, d90, over90, total }: { current: number; d30: number; d60: number; d90: number; over90: number; total: number }) {
  if (total === 0) return <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>No outstanding amounts</p>;
  const pct = (v: number) => Math.max(0, (v / total) * 100);
  return (
    <div className="space-y-2">
      <div className="flex h-4 rounded-full overflow-hidden" style={{ background: "var(--wp-dark-surface2)" }}>
        {current > 0 && <div style={{ width: `${pct(current)}%`, background: "var(--wp-success)" }} title={`Current: ${fmt(current)}`} />}
        {d30 > 0 && <div style={{ width: `${pct(d30)}%`, background: "var(--wp-info)" }} title={`1-30 days: ${fmt(d30)}`} />}
        {d60 > 0 && <div style={{ width: `${pct(d60)}%`, background: "var(--wp-warning)" }} title={`31-60 days: ${fmt(d60)}`} />}
        {d90 > 0 && <div style={{ width: `${pct(d90)}%`, background: "#f97316" }} title={`61-90 days: ${fmt(d90)}`} />}
        {over90 > 0 && <div style={{ width: `${pct(over90)}%`, background: "var(--wp-error)" }} title={`90+ days: ${fmt(over90)}`} />}
      </div>
      <div className="flex gap-3 flex-wrap text-xs">
        <span style={{ color: "var(--wp-success)" }}>Current {fmt(current)}</span>
        <span style={{ color: "var(--wp-info)" }}>1-30d {fmt(d30)}</span>
        <span style={{ color: "var(--wp-warning)" }}>31-60d {fmt(d60)}</span>
        <span style={{ color: "#f97316" }}>61-90d {fmt(d90)}</span>
        <span style={{ color: "var(--wp-error)" }}>90+d {fmt(over90)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FinancialsPage() {
  const [data, setData] = useState<FinancialData | null>(null);
  const [loading, setLoading] = useState(true);

  function getToken() {
    return localStorage.getItem("apex_token") || "";
  }

  const fetchData = useCallback(async () => {
    try {
      // Track page view
      fetch("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "financials" } }),
      }).catch(() => {});

      const res = await fetch("/api/quickbooks", {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.status === 403) {
        setData(null);
        setLoading(false);
        return;
      }
      const json = await res.json();
      setData(json);
    } catch {
      // Non-fatal
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading financials...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold mb-4" style={{ color: "var(--wp-gold)" }}>Financials</h1>
        <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>Financial data is restricted to CEO and CTO roles.</p>
      </div>
    );
  }

  if (!data.connection?.connected && data.connection?.mode !== "shadow") {
    return (
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold mb-4" style={{ color: "var(--wp-gold)" }}>Financials</h1>
        <SectionCard title="Connect QuickBooks">
          <p className="text-sm mb-4" style={{ color: "var(--wp-text-dim)" }}>
            Connect your QuickBooks Online account to see P&L, balance sheet, cash flow, invoices, and more.
          </p>
          <button
            onClick={async () => {
              const res = await fetch("/api/quickbooks?action=auth-url", {
                headers: { Authorization: `Bearer ${getToken()}` },
              });
              const data = await res.json();
              if (data.authUrl) {
                window.location.href = data.authUrl;
              }
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            Connect QuickBooks
          </button>
        </SectionCard>
      </div>
    );
  }

  const pnl = data.profitAndLoss;
  const bs = data.balanceSheet;
  const cf = data.cashFlow;
  const ar = data.agedReceivables;
  const ap = data.agedPayables;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>Financials</h1>
          {data.companyInfo && (
            <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
              {data.companyInfo.companyName}
              {data.connection?.mode === "shadow" && (
                <span className="ml-2 text-xs px-2 py-0.5 rounded-full" style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-muted)" }}>
                  Demo Data
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Top-line KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: "Revenue MTD", value: fmt(pnl?.totalIncome ?? 0), color: "var(--wp-gold)" },
          { label: "Expenses MTD", value: fmt(pnl?.totalExpenses ?? 0), color: "var(--wp-warning)" },
          { label: "Net Profit", value: fmt(pnl?.netIncome ?? 0), color: (pnl?.netIncome ?? 0) >= 0 ? "var(--wp-success)" : "var(--wp-error)" },
          { label: "Total Assets", value: fmt(bs?.totalAssets ?? 0), color: "var(--wp-info)" },
          { label: "AR Outstanding", value: fmt(ar?.total ?? 0), color: (ar?.over90 ?? 0) > 0 ? "var(--wp-error)" : "var(--wp-text)" },
          { label: "AP Outstanding", value: fmt(ap?.total ?? 0), color: "var(--wp-text-dim)" },
        ].map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-lg p-4 border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <p className="text-xl font-bold" style={{ color: kpi.color }}>{kpi.value}</p>
            <p className="text-xs mt-1" style={{ color: "var(--wp-text-dim)" }}>{kpi.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* P&L */}
        {pnl && (
          <SectionCard title="Profit & Loss">
            <div className="space-y-0.5 mb-3">
              <p className="text-xs mb-2" style={{ color: "var(--wp-text-muted)" }}>
                {fmtDate(pnl.startDate)} to {fmtDate(pnl.endDate)}
              </p>
              <h3 className="text-xs font-medium mt-2 mb-1" style={{ color: "var(--wp-success)" }}>Income</h3>
              {pnl.incomeCategories.map((c, i) => (
                <MetricRow key={i} label={c.name} value={fmt(c.amount)} color="var(--wp-success)" />
              ))}
              <MetricRow label="Total Income" value={fmt(pnl.totalIncome)} color="var(--wp-success)" />

              <h3 className="text-xs font-medium mt-3 mb-1" style={{ color: "var(--wp-error)" }}>Expenses</h3>
              {pnl.expenseCategories.map((c, i) => (
                <MetricRow key={i} label={c.name} value={fmt(c.amount)} color="var(--wp-error)" />
              ))}
              <MetricRow label="Total Expenses" value={fmt(pnl.totalExpenses)} color="var(--wp-error)" />

              <div className="pt-2 mt-2 border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                <MetricRow
                  label="Net Income"
                  value={fmt(pnl.netIncome)}
                  color={pnl.netIncome >= 0 ? "var(--wp-success)" : "var(--wp-error)"}
                />
              </div>
            </div>
          </SectionCard>
        )}

        {/* Balance Sheet */}
        {bs && (
          <SectionCard title="Balance Sheet">
            <p className="text-xs mb-2" style={{ color: "var(--wp-text-muted)" }}>
              As of {fmtDate(bs.asOfDate)}
            </p>

            <h3 className="text-xs font-medium mb-1" style={{ color: "var(--wp-info)" }}>Assets</h3>
            {bs.assets.map((a, i) => (
              <MetricRow key={i} label={a.name} value={fmt(a.amount)} color="var(--wp-info)" />
            ))}
            <MetricRow label="Total Assets" value={fmt(bs.totalAssets)} color="var(--wp-info)" />

            <h3 className="text-xs font-medium mt-3 mb-1" style={{ color: "var(--wp-warning)" }}>Liabilities</h3>
            {bs.liabilities.map((l, i) => (
              <MetricRow key={i} label={l.name} value={fmt(l.amount)} color="var(--wp-warning)" />
            ))}
            <MetricRow label="Total Liabilities" value={fmt(bs.totalLiabilities)} color="var(--wp-warning)" />

            <h3 className="text-xs font-medium mt-3 mb-1" style={{ color: "var(--wp-gold)" }}>Equity</h3>
            {bs.equity.map((e, i) => (
              <MetricRow key={i} label={e.name} value={fmt(e.amount)} color="var(--wp-gold)" />
            ))}
            <MetricRow label="Total Equity" value={fmt(bs.totalEquity)} color="var(--wp-gold)" />
          </SectionCard>
        )}

        {/* Cash Flow */}
        {cf && (
          <SectionCard title="Cash Flow">
            <p className="text-xs mb-2" style={{ color: "var(--wp-text-muted)" }}>
              {fmtDate(cf.startDate)} to {fmtDate(cf.endDate)}
            </p>
            <MetricRow label="Operating Activities" value={fmt(cf.operatingActivities)} color={cf.operatingActivities >= 0 ? "var(--wp-success)" : "var(--wp-error)"} />
            <MetricRow label="Investing Activities" value={fmt(cf.investingActivities)} />
            <MetricRow label="Financing Activities" value={fmt(cf.financingActivities)} />
            <div className="pt-2 mt-2 border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
              <MetricRow
                label="Net Cash Change"
                value={fmt(cf.netCashChange)}
                color={cf.netCashChange >= 0 ? "var(--wp-success)" : "var(--wp-error)"}
              />
            </div>
          </SectionCard>
        )}

        {/* Accounts Receivable Aging */}
        {ar && (
          <SectionCard title="Accounts Receivable Aging">
            <MetricRow label="Total Outstanding" value={fmt(ar.total)} color={ar.over90 > 0 ? "var(--wp-error)" : "var(--wp-text)"} />
            <div className="mt-3">
              <AgingBar current={ar.current} d30={ar.days1to30} d60={ar.days31to60} d90={ar.days61to90} over90={ar.over90} total={ar.total} />
            </div>
            {ar.details.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                      <th className="text-left pb-2">Customer</th>
                      <th className="text-right pb-2">Current</th>
                      <th className="text-right pb-2">1-30d</th>
                      <th className="text-right pb-2">31-60d</th>
                      <th className="text-right pb-2">61-90d</th>
                      <th className="text-right pb-2">90+d</th>
                      <th className="text-right pb-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ar.details.map((row, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                        <td className="py-1.5" style={{ color: "var(--wp-text)" }}>{row.name}</td>
                        <td className="text-right font-mono" style={{ color: "var(--wp-success)" }}>{row.current > 0 ? fmt(row.current) : "-"}</td>
                        <td className="text-right font-mono" style={{ color: "var(--wp-info)" }}>{row.days1to30 > 0 ? fmt(row.days1to30) : "-"}</td>
                        <td className="text-right font-mono" style={{ color: "var(--wp-warning)" }}>{row.days31to60 > 0 ? fmt(row.days31to60) : "-"}</td>
                        <td className="text-right font-mono" style={{ color: "#f97316" }}>{row.days61to90 > 0 ? fmt(row.days61to90) : "-"}</td>
                        <td className="text-right font-mono" style={{ color: "var(--wp-error)" }}>{row.over90 > 0 ? fmt(row.over90) : "-"}</td>
                        <td className="text-right font-mono font-medium">{fmt(row.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        )}
      </div>

      {/* Full-width sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Unpaid Invoices */}
        <SectionCard title={`Unpaid Invoices (${data.unpaidInvoices.length})`}>
          {data.unpaidInvoices.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>All invoices paid</p>
          ) : (
            <div className="space-y-0">
              {data.unpaidInvoices.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between py-2 border-b last:border-b-0"
                  style={{ borderColor: "var(--wp-dark-border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>{inv.customerName}</p>
                    <p className="text-xs" style={{ color: isOverdue(inv.dueDate) ? "var(--wp-error)" : "var(--wp-text-muted)" }}>
                      Due {fmtDate(inv.dueDate)}
                      {isOverdue(inv.dueDate) && " (overdue)"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-mono font-medium" style={{ color: "var(--wp-warning)" }}>
                      {fmt(inv.balance)}
                    </p>
                    {inv.balance !== inv.amount && (
                      <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                        of {fmt(inv.amount)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Recent Payments */}
        <SectionCard title={`Recent Payments (${data.recentPayments.length})`}>
          {data.recentPayments.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>No recent payments</p>
          ) : (
            <div className="space-y-0">
              {data.recentPayments.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between py-2 border-b last:border-b-0"
                  style={{ borderColor: "var(--wp-dark-border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>{p.customerName}</p>
                    <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                      {fmtDate(p.date)} {p.method && `via ${p.method}`}
                    </p>
                  </div>
                  <span className="text-sm font-mono font-medium" style={{ color: "var(--wp-success)" }}>
                    +{fmt(p.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Accounts Payable Aging */}
      {ap && ap.total > 0 && (
        <SectionCard title="Accounts Payable Aging">
          <MetricRow label="Total Outstanding" value={fmt(ap.total)} />
          <div className="mt-3">
            <AgingBar current={ap.current} d30={ap.days1to30} d60={ap.days31to60} d90={ap.days61to90} over90={ap.over90} total={ap.total} />
          </div>
          {ap.details.length > 0 && (
            <div className="mt-4">
              {ap.details.map((row, i) => (
                <MetricRow key={i} label={row.name} value={fmt(row.total)} />
              ))}
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}
