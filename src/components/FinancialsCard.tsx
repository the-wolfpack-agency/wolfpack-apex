"use client";

import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FinancialMetrics {
  connected: boolean;
  companyName: string | null;
  lastSync: string | null;
  cashPosition: number;
  revenueThisMonth: number;
  revenueLastMonth: number;
  netProfitMTD: number;
  unpaidInvoices: { count: number; total: number };
  overdueAR: { count: number; total: number };
  billsDueThisWeek: { count: number; total: number };
  recentPayments: { customer: string; amount: number; date: string }[];
  topCustomers: { name: string; revenue: number }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function revenueChangeClass(current: number, previous: number): string {
  if (previous === 0) return "var(--wp-text-dim)";
  const pct = ((current - previous) / previous) * 100;
  if (pct > 5) return "var(--wp-success)";
  if (pct < -5) return "var(--wp-error)";
  return "var(--wp-text-dim)";
}

function revenueChangeText(current: number, previous: number): string {
  if (previous === 0) return "";
  const pct = ((current - previous) / previous) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}% vs last month`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FinancialsCard() {
  const [metrics, setMetrics] = useState<FinancialMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function getToken() {
    return localStorage.getItem("apex_token") || "";
  }

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/quickbooks", {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.status === 401) return;
      if (res.status === 403) {
        setError("restricted");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setMetrics(data);
      setError(null);
    } catch {
      setError("Unable to load financial data");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchMetrics();
    // Refresh every 15 minutes
    const interval = setInterval(fetchMetrics, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  // Don't render for non-CEO/CTO roles
  if (error === "restricted") return null;

  if (loading) {
    return (
      <div
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
          Financials
        </h2>
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading...</p>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
          Financials
        </h2>
        <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
          {error || "No financial data available"}
        </p>
      </div>
    );
  }

  if (!metrics.connected) {
    return (
      <div
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-lg font-semibold mb-3" style={{ color: "var(--wp-gold)" }}>
          Financials
        </h2>
        <p className="text-sm mb-4" style={{ color: "var(--wp-text-dim)" }}>
          Connect QuickBooks to see your financial dashboard.
        </p>
        <a
          href="/api/quickbooks?action=auth-url"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          Connect QuickBooks
        </a>
      </div>
    );
  }

  // --- Connected: show metrics ---
  const metricCards = [
    {
      label: "Cash Position",
      value: formatCurrency(metrics.cashPosition),
      color: metrics.cashPosition > 0 ? "var(--wp-success)" : "var(--wp-error)",
    },
    {
      label: "Revenue MTD",
      value: formatCurrency(metrics.revenueThisMonth),
      color: "var(--wp-gold)",
      subtitle: revenueChangeText(metrics.revenueThisMonth, metrics.revenueLastMonth),
      subtitleColor: revenueChangeClass(metrics.revenueThisMonth, metrics.revenueLastMonth),
    },
    {
      label: "Net Profit MTD",
      value: formatCurrency(metrics.netProfitMTD),
      color: metrics.netProfitMTD >= 0 ? "var(--wp-success)" : "var(--wp-error)",
    },
    {
      label: "Unpaid Invoices",
      value: formatCurrency(metrics.unpaidInvoices.total),
      color: "var(--wp-warning)",
      subtitle: `${metrics.unpaidInvoices.count} invoice${metrics.unpaidInvoices.count !== 1 ? "s" : ""}`,
      subtitleColor: "var(--wp-text-dim)",
    },
  ];

  return (
    <div
      className="rounded-lg p-5 border"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: "var(--wp-gold)" }}>
          Financials
        </h2>
        <div className="flex items-center gap-2">
          {metrics.companyName && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text-dim)" }}>
              {metrics.companyName}
            </span>
          )}
          <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
            via QuickBooks
          </span>
        </div>
      </div>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {metricCards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg p-3 border"
            style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
          >
            <p className="text-xl font-bold" style={{ color: card.color }}>
              {card.value}
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--wp-text-dim)" }}>
              {card.label}
            </p>
            {card.subtitle && (
              <p className="text-xs mt-0.5" style={{ color: card.subtitleColor }}>
                {card.subtitle}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Secondary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        {/* Overdue AR */}
        <div
          className="rounded-lg p-3 border"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Overdue Receivables</span>
            <span
              className="text-sm font-bold"
              style={{ color: metrics.overdueAR.total > 0 ? "var(--wp-error)" : "var(--wp-success)" }}
            >
              {formatCurrency(metrics.overdueAR.total)}
            </span>
          </div>
          {metrics.overdueAR.count > 0 && (
            <p className="text-xs mt-1" style={{ color: "var(--wp-error)" }}>
              {metrics.overdueAR.count} overdue
            </p>
          )}
        </div>

        {/* Bills Due */}
        <div
          className="rounded-lg p-3 border"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Bills Due This Week</span>
            <span className="text-sm font-bold" style={{ color: "var(--wp-warning)" }}>
              {formatCurrency(metrics.billsDueThisWeek.total)}
            </span>
          </div>
          {metrics.billsDueThisWeek.count > 0 && (
            <p className="text-xs mt-1" style={{ color: "var(--wp-text-muted)" }}>
              {metrics.billsDueThisWeek.count} bill{metrics.billsDueThisWeek.count !== 1 ? "s" : ""} due
            </p>
          )}
        </div>
      </div>

      {/* Top Customers */}
      {metrics.topCustomers.length > 0 && (
        <div className="mb-3">
          <h3 className="text-sm font-medium mb-2" style={{ color: "var(--wp-text-dim)" }}>
            Top Customers (MTD)
          </h3>
          <div className="space-y-1.5">
            {metrics.topCustomers.slice(0, 5).map((c, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span style={{ color: "var(--wp-text)" }}>{c.name}</span>
                <span className="font-mono" style={{ color: "var(--wp-gold)" }}>
                  {formatCurrency(c.revenue)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Payments */}
      {metrics.recentPayments.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2" style={{ color: "var(--wp-text-dim)" }}>
            Recent Payments
          </h3>
          <div className="space-y-1.5">
            {metrics.recentPayments.slice(0, 3).map((p, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span style={{ color: "var(--wp-text)" }}>{p.customer}</span>
                <span className="font-mono" style={{ color: "var(--wp-success)" }}>
                  +{formatCurrency(p.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Last sync */}
      {metrics.lastSync && (
        <p className="text-xs mt-3 text-right" style={{ color: "var(--wp-text-muted)" }}>
          Last synced: {new Date(metrics.lastSync).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
