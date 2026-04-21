"use client";

/**
 * AddKrForm — lets any authenticated teammate add a Key Result under
 * an existing company OKR. No role gate: "individual team members
 * should have the ability to add KRs to supplement the overarching
 * company goals" (spec 2026-04-21).
 *
 * POST /api/goals/okrs/[okrId]/krs → fires goal.kr_added on the server.
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface Props {
  okrId: string;
  onAdded: () => void;
}

type Cadence = "daily" | "weekly" | "monthly" | "quarterly";

export default function AddKrForm({ okrId, onAdded }: Props) {
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState("");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    metric.trim().length > 0 &&
    target.trim().length > 0 &&
    Number.isFinite(parseFloat(target));

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetchWithRefresh(
          `/api/goals/okrs/${encodeURIComponent(okrId)}/krs`,
          {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({
              metric: metric.trim(),
              target: parseFloat(target),
              unit: unit.trim() || null,
              cadence,
            }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(typeof body.error === "string" ? body.error : "Failed to add KR");
          setSubmitting(false);
          return;
        }
        setMetric("");
        setTarget("");
        setUnit("");
        setCadence("weekly");
        setOpen(false);
        setSubmitting(false);
        onAdded();
      } catch {
        setError("Network error");
        setSubmitting(false);
      }
    },
    [canSubmit, submitting, okrId, metric, target, unit, cadence, onAdded],
  );

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`add-kr-open-${okrId}`}
        onClick={() => setOpen(true)}
        className="text-xs"
        style={{ color: "var(--wp-gold)" }}
      >
        + Add KR
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid={`add-kr-form-${okrId}`}
      className="rounded-md border p-2 space-y-2 w-full overflow-hidden"
      style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
    >
      <div className="grid grid-cols-2 gap-2">
        <input
          data-testid={`add-kr-metric-${okrId}`}
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
          placeholder="Metric"
          className="text-sm rounded-md border px-2 py-1 col-span-2 min-w-0 w-full"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <input
          data-testid={`add-kr-target-${okrId}`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Target"
          inputMode="decimal"
          className="text-sm rounded-md border px-2 py-1 min-w-0 w-full"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <input
          data-testid={`add-kr-unit-${okrId}`}
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="Unit"
          className="text-sm rounded-md border px-2 py-1 min-w-0 w-full"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <select
          data-testid={`add-kr-cadence-${okrId}`}
          value={cadence}
          onChange={(e) => setCadence(e.target.value as Cadence)}
          className="text-sm rounded-md border px-2 py-1 col-span-2 min-w-0 w-full"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        >
          <option value="daily">daily</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
          <option value="quarterly">quarterly</option>
        </select>
      </div>
      {error && (
        <p data-testid={`add-kr-error-${okrId}`} className="text-xs" style={{ color: "var(--wp-warning)" }}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          data-testid={`add-kr-submit-${okrId}`}
          disabled={!canSubmit || submitting}
          className="px-3 py-1 rounded text-xs font-semibold disabled:opacity-50"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {submitting ? "Adding…" : "Add KR"}
        </button>
        <button
          type="button"
          data-testid={`add-kr-cancel-${okrId}`}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="text-xs"
          style={{ color: "var(--wp-text-dim)" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
