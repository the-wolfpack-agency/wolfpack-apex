"use client";

/**
 * ManageKrButton — admin-only edit + delete for an existing KR.
 * PATCH /api/goals/krs/[id] with metric/target/unit/cadence fields
 * (route enforces the role gate too), or DELETE /api/goals/krs/[id].
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, authHeaders, jsonHeaders } from "@/lib/client-auth";

type Cadence = "daily" | "weekly" | "monthly" | "quarterly";

interface Props {
  krId: string;
  currentMetric: string;
  currentTarget: number;
  currentUnit: string | null;
  currentCadence: Cadence;
  userRole: string | null;
  onChanged: () => void;
}

export default function ManageKrButton({
  krId,
  currentMetric,
  currentTarget,
  currentUnit,
  currentCadence,
  userRole,
  onChanged,
}: Props) {
  const isAdmin = userRole === "ceo" || userRole === "cto" || userRole === "evp";
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState(currentMetric);
  const [target, setTarget] = useState(String(currentTarget));
  const [unit, setUnit] = useState(currentUnit ?? "");
  const [cadence, setCadence] = useState<Cadence>(currentCadence);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedTarget = parseFloat(target);
  const changed =
    metric.trim() !== currentMetric.trim() ||
    parsedTarget !== currentTarget ||
    (unit.trim() || null) !== (currentUnit ?? null) ||
    cadence !== currentCadence;

  const canSubmit =
    changed &&
    metric.trim().length > 0 &&
    target.trim().length > 0 &&
    Number.isFinite(parsedTarget);

  const save = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/goals/krs/${encodeURIComponent(krId)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({
            metric: metric.trim(),
            target: parsedTarget,
            unit: unit.trim() || null,
            cadence,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "Failed to save");
        setSubmitting(false);
        return;
      }
      setOpen(false);
      setSubmitting(false);
      onChanged();
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }, [canSubmit, submitting, krId, metric, parsedTarget, unit, cadence, onChanged]);

  const remove = useCallback(async () => {
    if (submitting) return;
    if (!window.confirm(`Delete KR "${currentMetric}"? This cannot be undone.`)) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/goals/krs/${encodeURIComponent(krId)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "Failed to delete");
        setSubmitting(false);
        return;
      }
      setOpen(false);
      setSubmitting(false);
      onChanged();
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }, [submitting, krId, currentMetric, onChanged]);

  if (!isAdmin) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`manage-kr-open-${krId}`}
        onClick={() => {
          setMetric(currentMetric);
          setTarget(String(currentTarget));
          setUnit(currentUnit ?? "");
          setCadence(currentCadence);
          setOpen(true);
          setError(null);
        }}
        className="text-xs"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Edit / Delete KR
      </button>
    );
  }

  return (
    <form
      onSubmit={save}
      data-testid={`manage-kr-form-${krId}`}
      className="rounded-md border p-2 space-y-2 w-full overflow-hidden"
      style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
    >
      <div className="grid grid-cols-2 gap-2">
        <input
          data-testid={`manage-kr-metric-${krId}`}
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
          placeholder="Metric"
          className="text-sm rounded-md border px-2 py-1 col-span-2 min-w-0 w-full"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <input
          data-testid={`manage-kr-target-${krId}`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Target"
          inputMode="decimal"
          className="text-sm rounded-md border px-2 py-1 min-w-0 w-full"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <input
          data-testid={`manage-kr-unit-${krId}`}
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="Unit"
          className="text-sm rounded-md border px-2 py-1 min-w-0 w-full"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <select
          data-testid={`manage-kr-cadence-${krId}`}
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
        <p data-testid={`manage-kr-error-${krId}`} className="text-xs" style={{ color: "var(--wp-warning)" }}>
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 items-center">
        <button
          type="submit"
          data-testid={`manage-kr-save-${krId}`}
          disabled={!canSubmit || submitting}
          className="px-3 py-1 rounded text-xs font-semibold disabled:opacity-50"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {submitting ? "…" : "Save"}
        </button>
        <button
          type="button"
          data-testid={`manage-kr-delete-${krId}`}
          onClick={remove}
          disabled={submitting}
          className="px-3 py-1 rounded text-xs font-semibold disabled:opacity-50"
          style={{ background: "var(--wp-warning)", color: "var(--wp-dark)" }}
        >
          Delete
        </button>
        <button
          type="button"
          data-testid={`manage-kr-cancel-${krId}`}
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
