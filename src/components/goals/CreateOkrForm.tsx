"use client";

/**
 * CreateOkrForm — admin-only (ceo/cto) form to seed a new company OKR
 * with one or more Key Results. Closes the "no UI, seed via API" gap
 * that left the /goals page looking unfinished for non-engineers.
 *
 * Fires goal.okr_created_ui via the POST route; that event is
 * triple-written to PG + Qdrant + Neo4j by trackEvent / tripleWriteEvent.
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface KrDraft {
  metric: string;
  target: string;
  unit: string;
  cadence: "daily" | "weekly" | "monthly" | "quarterly";
}

interface Props {
  userRole: string | null;
  onCreated: () => void;
}

function currentQuarter(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

export default function CreateOkrForm({ userRole, onCreated }: Props) {
  const isAdmin = userRole === "ceo" || userRole === "cto";
  const [open, setOpen] = useState(false);
  const [quarter, setQuarter] = useState(currentQuarter());
  const [objective, setObjective] = useState("");
  const [krs, setKrs] = useState<KrDraft[]>([
    { metric: "", target: "", unit: "", cadence: "weekly" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    QUARTER_RE.test(quarter) &&
    objective.trim().length > 0 &&
    krs.length > 0 &&
    krs.every((k) => k.metric.trim() && k.target.trim() && Number.isFinite(parseFloat(k.target)));

  const updateKr = useCallback((i: number, patch: Partial<KrDraft>) => {
    setKrs((prev) => prev.map((k, idx) => (idx === i ? { ...k, ...patch } : k)));
  }, []);

  const addKr = useCallback(() => {
    setKrs((prev) => [...prev, { metric: "", target: "", unit: "", cadence: "weekly" }]);
  }, []);

  const removeKr = useCallback((i: number) => {
    setKrs((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetchWithRefresh("/api/goals/okrs", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            quarter,
            objective: objective.trim(),
            krs: krs.map((k) => ({
              metric: k.metric.trim(),
              target: parseFloat(k.target),
              unit: k.unit.trim() || null,
              cadence: k.cadence,
            })),
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(typeof body.error === "string" ? body.error : "Failed to create OKR");
          setSubmitting(false);
          return;
        }
        // Reset + close
        setObjective("");
        setKrs([{ metric: "", target: "", unit: "", cadence: "weekly" }]);
        setOpen(false);
        setSubmitting(false);
        onCreated();
      } catch {
        setError("Network error");
        setSubmitting(false);
      }
    },
    [canSubmit, submitting, quarter, objective, krs, onCreated],
  );

  if (!isAdmin) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-testid="create-okr-open"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm font-semibold transition-colors"
        style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
      >
        + New OKR
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="create-okr-form"
      className="rounded-lg border p-4 space-y-3"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: "var(--wp-gold)" }}>
          New OKR
        </h3>
        <button
          type="button"
          data-testid="create-okr-close"
          onClick={() => setOpen(false)}
          className="text-xs"
          style={{ color: "var(--wp-text-dim)" }}
        >
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="flex flex-col gap-1 sm:col-span-1">
          <span className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
            Quarter
          </span>
          <input
            data-testid="create-okr-quarter"
            value={quarter}
            onChange={(e) => setQuarter(e.target.value)}
            placeholder="2026-Q2"
            className="text-sm rounded-md border px-2 py-1"
            style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
            Objective
          </span>
          <input
            data-testid="create-okr-objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="What does the team want to achieve this quarter?"
            className="text-sm rounded-md border px-2 py-1"
            style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
          />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold" style={{ color: "var(--wp-text-dim)" }}>
            Key Results
          </span>
          <button
            type="button"
            data-testid="create-okr-add-kr"
            onClick={addKr}
            className="text-xs"
            style={{ color: "var(--wp-gold)" }}
          >
            + Add KR
          </button>
        </div>
        {krs.map((kr, i) => (
          <div
            key={i}
            data-testid={`create-okr-kr-${i}`}
            className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2"
          >
            <input
              data-testid={`create-okr-kr-${i}-metric`}
              value={kr.metric}
              onChange={(e) => updateKr(i, { metric: e.target.value })}
              placeholder="Metric (e.g. weekly active users)"
              className="text-sm rounded-md border px-2 py-1"
              style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
            />
            <input
              data-testid={`create-okr-kr-${i}-target`}
              value={kr.target}
              onChange={(e) => updateKr(i, { target: e.target.value })}
              placeholder="Target"
              inputMode="decimal"
              className="text-sm rounded-md border px-2 py-1"
              style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
            />
            <input
              data-testid={`create-okr-kr-${i}-unit`}
              value={kr.unit}
              onChange={(e) => updateKr(i, { unit: e.target.value })}
              placeholder="Unit"
              className="text-sm rounded-md border px-2 py-1"
              style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
            />
            <select
              data-testid={`create-okr-kr-${i}-cadence`}
              value={kr.cadence}
              onChange={(e) => updateKr(i, { cadence: e.target.value as KrDraft["cadence"] })}
              className="text-sm rounded-md border px-2 py-1"
              style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
            >
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
              <option value="monthly">monthly</option>
              <option value="quarterly">quarterly</option>
            </select>
            <button
              type="button"
              data-testid={`create-okr-kr-${i}-remove`}
              onClick={() => removeKr(i)}
              disabled={krs.length <= 1}
              className="text-xs disabled:opacity-30"
              style={{ color: "var(--wp-text-dim)" }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {error && (
        <p data-testid="create-okr-error" className="text-xs" style={{ color: "var(--wp-warning)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        data-testid="create-okr-submit"
        disabled={!canSubmit || submitting}
        className="w-full px-3 py-1.5 rounded text-sm font-semibold transition-colors disabled:opacity-50"
        style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
      >
        {submitting ? "Creating…" : "Create OKR"}
      </button>
    </form>
  );
}
