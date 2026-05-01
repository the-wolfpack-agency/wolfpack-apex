"use client";

/**
 * /programs/budgets — list + create + import flow.
 *
 * Drop a WPA xlsx onto the page → the importer creates the budget +
 * fills lines + redirects to the detail view.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRefresh, getInstinctUser } from "@/lib/client-auth";

interface BudgetRow {
  id: string;
  name: string;
  jobNumber: string | null;
  version: string;
  status: string;
  contingencyPct: number;
  updatedAt: string;
}

export default function BudgetsListPage() {
  const user = getInstinctUser<{ id: string; name?: string; role?: string }>();
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/programs/budgets");
      if (res.status === 401) {
        window.location.href = "/login?next=/programs/budgets";
        return;
      }
      if (!res.ok) throw new Error(`load ${res.status}`);
      const j = (await res.json()) as { budgets: BudgetRow[] };
      setBudgets(j.budgets);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetchWithRefresh("/api/programs/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const j = (await res.json()) as { budget?: { id: string }; error?: string };
      if (!res.ok || !j.budget) {
        setError(j.error || `create ${res.status}`);
      } else {
        window.location.href = `/programs/budgets/${j.budget.id}`;
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setCreating(false);
  }

  async function handleImport(file: File) {
    setImporting(true);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetchWithRefresh("/api/programs/budgets/import-xlsx", {
        method: "POST",
        body: fd,
      });
      const j = (await res.json()) as {
        budgetId?: string;
        inserted?: number;
        unmatchedSections?: string[];
        error?: string;
      };
      if (!res.ok || !j.budgetId) {
        setImportResult(`Import failed: ${j.error || res.status}`);
      } else {
        const unmatched = j.unmatchedSections || [];
        const note =
          unmatched.length > 0
            ? ` Unmatched sections: ${unmatched.join(", ")}.`
            : "";
        setImportResult(
          `Imported ${j.inserted ?? 0} line(s).${note} Redirecting…`,
        );
        setTimeout(() => {
          window.location.href = `/programs/budgets/${j.budgetId}`;
        }, 600);
      }
    } catch (e) {
      setImportResult(`Import failed: ${(e as Error).message}`);
    }
    setImporting(false);
  }

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center" style={{ background: "var(--wp-dark)" }}>
        <span style={{ color: "var(--wp-text-dim)" }}>Loading…</span>
      </main>
    );
  }

  return (
    <main
      className="px-6 py-6 space-y-6"
      style={{ background: "var(--wp-dark)", minHeight: "100%" }}
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
            Program Cost Budgets
          </h1>
          <p className="text-xs mt-1" style={{ color: "var(--wp-text-muted)" }}>
            Track planned vs actual outside costs. Drop a WPA xlsx to import an
            existing budget, or create one from scratch.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <input
            data-testid="budget-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New budget name"
            className="px-2 py-1.5 rounded text-sm"
            style={{
              background: "var(--wp-dark-surface)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-dark-border)",
            }}
          />
          <button
            type="button"
            data-testid="budget-create"
            disabled={creating || !newName.trim()}
            onClick={() => void handleCreate()}
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              opacity: creating || !newName.trim() ? 0.5 : 1,
            }}
          >
            {creating ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            data-testid="budget-import"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
            className="px-3 py-1.5 rounded text-xs"
            style={{
              background: "var(--wp-dark-surface2)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-dark-border)",
            }}
          >
            {importing ? "Importing…" : "Import xlsx"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            style={{ display: "none" }}
            data-testid="budget-import-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {error && (
        <div
          data-testid="budgets-error"
          className="text-sm rounded p-2"
          style={{ background: "rgba(239,68,68,0.12)", color: "var(--wp-error)" }}
        >
          {error}
        </div>
      )}
      {importResult && (
        <div
          data-testid="budgets-import-result"
          className="text-xs"
          style={{ color: "var(--wp-text-muted)" }}
        >
          {importResult}
        </div>
      )}

      {loading ? (
        <div data-testid="budgets-loading" style={{ color: "var(--wp-text-dim)" }}>
          Loading…
        </div>
      ) : budgets.length === 0 ? (
        <div
          data-testid="budgets-empty"
          style={{ color: "var(--wp-text-muted)" }}
          className="text-sm"
        >
          No budgets yet. Drop a WPA xlsx or create one to get started.
        </div>
      ) : (
        <ul className="space-y-1.5" data-testid="budgets-list">
          {budgets.map((b) => (
            <li
              key={b.id}
              data-testid={`budget-row-${b.id}`}
              className="rounded px-3 py-2 flex items-center justify-between gap-3 text-xs"
              style={{ background: "var(--wp-dark-surface)" }}
            >
              <a
                href={`/programs/budgets/${b.id}`}
                className="flex-1 truncate"
                style={{ color: "var(--wp-text)" }}
              >
                <strong>{b.name}</strong>
                <span className="ml-2" style={{ color: "var(--wp-text-muted)" }}>
                  {b.jobNumber || "no job #"} · {b.version} · {b.status}
                </span>
              </a>
              <a
                href={`/api/programs/budgets/${b.id}/export-xlsx`}
                className="px-2 py-0.5 rounded text-xs"
                style={{
                  background: "var(--wp-dark-surface2)",
                  color: "var(--wp-text)",
                  border: "1px solid var(--wp-dark-border)",
                }}
              >
                Export
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
