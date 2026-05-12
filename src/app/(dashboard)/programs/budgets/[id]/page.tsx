"use client";

/**
 * /programs/budgets/[id] — single budget detail.
 *
 * Roll-up summary at the top, per-category line editor below. Add /
 * edit / delete lines + record actuals inline.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fetchWithRefresh, getInstinctUser } from "@/lib/client-auth";

interface Category {
  id: string;
  code: number;
  name: string;
  kind: "fixed" | "variable";
  sortOrder: number;
}
interface BudgetLine {
  id: string;
  budgetId: string;
  categoryId: string;
  costCode: number | null;
  responsibleUserId: string | null;
  lineNumber: string | null;
  description: string | null;
  name: string | null;
  units: number;
  rate: number;
  total: number;
}
interface CategoryRollup {
  categoryId: string;
  code: number;
  name: string;
  kind: "fixed" | "variable";
  lineCount: number;
  plannedTotal: number;
  actualTotal: number;
  variance: number;
  variancePct: number | null;
}
interface BudgetRollup {
  fixed: CategoryRollup[];
  variable: CategoryRollup[];
  fixedSubtotal: number;
  variableSubtotal: number;
  plannedGrandTotal: number;
  actualGrandTotal: number;
  variance: number;
  contingencyAmount: number;
  contingencyPct: number;
}
interface BudgetActual {
  id: string;
  lineId: string;
  source: string;
  amount: number;
  vendor: string | null;
  occurredAt: string;
}
interface DetailResponse {
  budget: {
    id: string;
    name: string;
    jobNumber: string | null;
    version: string;
    status: string;
    contingencyPct: number;
  };
  lines: BudgetLine[];
  categories: Category[];
  rollup: BudgetRollup;
  actuals: BudgetActual[];
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function varianceColor(v: number): string {
  if (v > 0) return "var(--wp-error)";
  if (v < 0) return "var(--wp-success)";
  return "var(--wp-text-muted)";
}

export default function BudgetDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const user = getInstinctUser<{ id: string; role?: string }>();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addCategory, setAddCategory] = useState<string>("");
  const [actualLineId, setActualLineId] = useState<string | null>(null);
  const [actualAmount, setActualAmount] = useState("");
  const [actualVendor, setActualVendor] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/programs/budgets/${encodeURIComponent(id)}`,
      );
      if (res.status === 401) {
        window.location.href = "/login?next=/programs/budgets";
        return;
      }
      if (res.status === 404) {
        setError("not found");
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`load ${res.status}`);
      const j = (await res.json()) as DetailResponse;
      setData(j);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addLine() {
    if (!addCategory) return;
    const res = await fetchWithRefresh(
      `/api/programs/budgets/${encodeURIComponent(id)}/lines`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: addCategory, description: "" }),
      },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || `add ${res.status}`);
      return;
    }
    setAddCategory("");
    await load();
  }

  async function patchLine(line: BudgetLine, patch: Partial<BudgetLine>) {
    const res = await fetchWithRefresh(
      `/api/programs/budgets/${encodeURIComponent(id)}/lines/${encodeURIComponent(line.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || `patch ${res.status}`);
      return;
    }
    await load();
  }

  async function delLine(lineId: string) {
    if (!confirm("Delete this line?")) return;
    const res = await fetchWithRefresh(
      `/api/programs/budgets/${encodeURIComponent(id)}/lines/${encodeURIComponent(lineId)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      setError(`delete ${res.status}`);
      return;
    }
    await load();
  }

  async function recordActual() {
    if (!actualLineId) return;
    const amt = Number(actualAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("amount required");
      return;
    }
    const res = await fetchWithRefresh(
      `/api/programs/budgets/${encodeURIComponent(id)}/actuals`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineId: actualLineId,
          source: "manual",
          amount: amt,
          vendor: actualVendor || null,
        }),
      },
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || `actual ${res.status}`);
      return;
    }
    setActualLineId(null);
    setActualAmount("");
    setActualVendor("");
    await load();
  }

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center" style={{ background: "var(--wp-dark)" }}>
        <span style={{ color: "var(--wp-text-dim)" }}>Loading…</span>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="px-6 py-6" style={{ background: "var(--wp-dark)" }}>
        <div data-testid="budget-detail-loading" style={{ color: "var(--wp-text-dim)" }}>
          Loading…
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="px-6 py-6" style={{ background: "var(--wp-dark)" }}>
        <div data-testid="budget-detail-error" style={{ color: "var(--wp-error)" }}>
          {error || "not found"}
        </div>
      </main>
    );
  }

  const linesByCategory = new Map<string, BudgetLine[]>();
  for (const l of data.lines) {
    if (!linesByCategory.has(l.categoryId)) linesByCategory.set(l.categoryId, []);
    linesByCategory.get(l.categoryId)!.push(l);
  }
  const actualsByLine = new Map<string, BudgetActual[]>();
  for (const a of data.actuals) {
    if (!actualsByLine.has(a.lineId)) actualsByLine.set(a.lineId, []);
    actualsByLine.get(a.lineId)!.push(a);
  }
  const categoriesWithLines = data.categories.filter(
    (c) => linesByCategory.get(c.id)?.length,
  );

  return (
    <main
      className="px-6 py-6 space-y-6"
      style={{ background: "var(--wp-dark)", minHeight: "100%" }}
      data-testid="budget-detail"
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/programs/budgets" className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
            ← All budgets
          </Link>
          <h1 className="text-2xl font-bold mt-1" style={{ color: "var(--wp-gold)" }}>
            {data.budget.name}
          </h1>
          <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
            {data.budget.jobNumber || "no job #"} · {data.budget.version} · {data.budget.status}
          </p>
        </div>
        <a
          href={`/api/programs/budgets/${id}/export-xlsx`}
          className="px-3 py-1.5 rounded text-xs font-medium"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          data-testid="budget-export"
        >
          Export to xlsx
        </a>
      </header>

      <section
        data-testid="budget-rollup"
        className="grid grid-cols-1 sm:grid-cols-2 gap-3"
      >
        <RollupCard label="Fixed costs" total={data.rollup.fixedSubtotal} />
        <RollupCard label="Variable costs" total={data.rollup.variableSubtotal} />
        <RollupCard
          label={`Contingency (${data.rollup.contingencyPct}%)`}
          total={data.rollup.contingencyAmount}
        />
        <RollupCard
          label="Grand total (planned)"
          total={data.rollup.plannedGrandTotal}
          variance={data.rollup.variance}
          highlight
        />
      </section>

      <section
        className="rounded border p-3 space-y-2"
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
        }}
      >
        <div className="flex flex-wrap gap-2 items-center">
          <select
            data-testid="add-line-category"
            value={addCategory}
            onChange={(e) => setAddCategory(e.target.value)}
            className="px-2 py-1.5 rounded text-sm"
            style={{
              background: "var(--wp-dark)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-dark-border)",
            }}
          >
            <option value="">Add line to category…</option>
            {data.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.kind === "fixed" ? "F" : "V"} · {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="add-line-submit"
            disabled={!addCategory}
            onClick={() => void addLine()}
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              opacity: addCategory ? 1 : 0.5,
            }}
          >
            + Add line
          </button>
        </div>
      </section>

      {categoriesWithLines.length === 0 ? (
        <div data-testid="budget-no-lines" className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
          No detail lines yet. Add one above, or import a WPA xlsx from the list page.
        </div>
      ) : (
        categoriesWithLines.map((c) => {
          const lines = linesByCategory.get(c.id) || [];
          const subtotal = lines.reduce((s, l) => s + l.total, 0);
          return (
            <section
              key={c.id}
              data-testid={`category-${c.code}`}
              className="rounded border p-3 space-y-2"
              style={{
                background: "var(--wp-dark-surface)",
                borderColor: "var(--wp-dark-border)",
              }}
            >
              <header className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold" style={{ color: "var(--wp-text)" }}>
                  {c.name}
                  <span className="ml-2 text-xs" style={{ color: "var(--wp-text-muted)" }}>
                    ({c.kind})
                  </span>
                </h2>
                <span className="text-sm" style={{ color: "var(--wp-gold)" }}>
                  {fmt(subtotal)}
                </span>
              </header>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: "var(--wp-text-muted)" }}>
                    <th className="text-left pb-1.5">Description</th>
                    <th className="text-left pb-1.5">Name</th>
                    <th className="text-right pb-1.5">Units</th>
                    <th className="text-right pb-1.5">Rate</th>
                    <th className="text-right pb-1.5">Total</th>
                    <th className="text-right pb-1.5">Actual</th>
                    <th className="text-right pb-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const acts = actualsByLine.get(l.id) || [];
                    const actual = acts.reduce((s, a) => s + a.amount, 0);
                    return (
                      <tr key={l.id} data-testid={`line-${l.id}`}>
                        <td className="py-1">
                          <input
                            defaultValue={l.description ?? ""}
                            data-testid={`line-${l.id}-description`}
                            onBlur={(e) =>
                              e.target.value !== (l.description ?? "") &&
                              void patchLine(l, { description: e.target.value })
                            }
                            className="w-full px-1 py-0.5 rounded"
                            style={{
                              background: "var(--wp-dark)",
                              color: "var(--wp-text)",
                              border: "1px solid var(--wp-dark-border)",
                            }}
                          />
                        </td>
                        <td className="py-1">
                          <input
                            defaultValue={l.name ?? ""}
                            onBlur={(e) =>
                              e.target.value !== (l.name ?? "") &&
                              void patchLine(l, { name: e.target.value })
                            }
                            className="w-full px-1 py-0.5 rounded"
                            style={{
                              background: "var(--wp-dark)",
                              color: "var(--wp-text)",
                              border: "1px solid var(--wp-dark-border)",
                            }}
                          />
                        </td>
                        <td className="py-1 text-right">
                          <input
                            type="number"
                            step="0.01"
                            defaultValue={l.units}
                            data-testid={`line-${l.id}-units`}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isFinite(v) && v !== l.units)
                                void patchLine(l, { units: v });
                            }}
                            className="w-20 px-1 py-0.5 rounded text-right"
                            style={{
                              background: "var(--wp-dark)",
                              color: "var(--wp-text)",
                              border: "1px solid var(--wp-dark-border)",
                            }}
                          />
                        </td>
                        <td className="py-1 text-right">
                          <input
                            type="number"
                            step="0.01"
                            defaultValue={l.rate}
                            data-testid={`line-${l.id}-rate`}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isFinite(v) && v !== l.rate)
                                void patchLine(l, { rate: v });
                            }}
                            className="w-24 px-1 py-0.5 rounded text-right"
                            style={{
                              background: "var(--wp-dark)",
                              color: "var(--wp-text)",
                              border: "1px solid var(--wp-dark-border)",
                            }}
                          />
                        </td>
                        <td className="py-1 text-right" style={{ color: "var(--wp-text)" }}>
                          {fmt(l.total)}
                        </td>
                        <td
                          className="py-1 text-right"
                          style={{ color: varianceColor(actual - l.total) }}
                        >
                          {fmt(actual)}
                        </td>
                        <td className="py-1 text-right">
                          <button
                            type="button"
                            onClick={() => setActualLineId(l.id)}
                            className="px-1.5 py-0.5 rounded text-xs"
                            style={{
                              background: "var(--wp-dark-surface2)",
                              color: "var(--wp-text)",
                              border: "1px solid var(--wp-dark-border)",
                            }}
                            data-testid={`line-${l.id}-record-actual`}
                          >
                            + Actual
                          </button>
                          <button
                            type="button"
                            onClick={() => void delLine(l.id)}
                            className="ml-1 px-1.5 py-0.5 rounded text-xs"
                            style={{
                              background: "transparent",
                              color: "var(--wp-text-muted)",
                              border: "1px solid var(--wp-dark-border)",
                            }}
                            data-testid={`line-${l.id}-delete`}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {actualLineId && lines.find((l) => l.id === actualLineId) && (
                <div
                  data-testid="actual-form"
                  className="flex items-center gap-2 text-xs pt-2 border-t"
                  style={{ borderColor: "var(--wp-dark-border)" }}
                >
                  <span style={{ color: "var(--wp-text-muted)" }}>Record actual:</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Amount"
                    value={actualAmount}
                    onChange={(e) => setActualAmount(e.target.value)}
                    data-testid="actual-amount"
                    className="px-1.5 py-0.5 rounded w-24 text-right"
                    style={{
                      background: "var(--wp-dark)",
                      color: "var(--wp-text)",
                      border: "1px solid var(--wp-dark-border)",
                    }}
                  />
                  <input
                    placeholder="Vendor (optional)"
                    value={actualVendor}
                    onChange={(e) => setActualVendor(e.target.value)}
                    className="px-1.5 py-0.5 rounded flex-1"
                    style={{
                      background: "var(--wp-dark)",
                      color: "var(--wp-text)",
                      border: "1px solid var(--wp-dark-border)",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void recordActual()}
                    data-testid="actual-submit"
                    className="px-2 py-0.5 rounded font-medium"
                    style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
                  >
                    Record
                  </button>
                  <button
                    type="button"
                    onClick={() => setActualLineId(null)}
                    className="px-2 py-0.5 rounded"
                    style={{
                      background: "transparent",
                      color: "var(--wp-text-muted)",
                      border: "1px solid var(--wp-dark-border)",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </section>
          );
        })
      )}
    </main>
  );
}

function RollupCard({
  label,
  total,
  variance,
  highlight,
}: {
  label: string;
  total: number;
  variance?: number;
  highlight?: boolean;
}) {
  return (
    <article
      className="rounded border p-3"
      style={{
        background: highlight ? "var(--wp-dark-surface2)" : "var(--wp-dark-surface)",
        borderColor: highlight ? "var(--wp-gold)" : "var(--wp-dark-border)",
      }}
    >
      <div className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
        {label}
      </div>
      <div
        className="text-xl font-semibold mt-0.5"
        style={{ color: highlight ? "var(--wp-gold)" : "var(--wp-text)" }}
      >
        {fmt(total)}
      </div>
      {variance !== undefined && (
        <div className="text-xs mt-0.5" style={{ color: varianceColor(variance) }}>
          actual variance: {fmt(variance)}
        </div>
      )}
    </article>
  );
}
