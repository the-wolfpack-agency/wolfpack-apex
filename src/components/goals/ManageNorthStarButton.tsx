"use client";

/**
 * ManageNorthStarButton — admin-only edit + delete for the current
 * North Star snapshot. PATCH/DELETE /api/goals/north-star/[id].
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, authHeaders, jsonHeaders } from "@/lib/client-auth";

interface Props {
  snapshotId: string;
  currentValue: number;
  currentLabel: string;
  currentUnit: string | null;
  userRole: string | null;
  onChanged: () => void;
}

export default function ManageNorthStarButton({
  snapshotId,
  currentValue,
  currentLabel,
  currentUnit,
  userRole,
  onChanged,
}: Props) {
  const isAdmin = userRole === "ceo" || userRole === "cto";
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(currentValue));
  const [label, setLabel] = useState(currentLabel);
  const [unit, setUnit] = useState(currentUnit ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    label.trim().length > 0 &&
    value.trim().length > 0 &&
    Number.isFinite(parseFloat(value));

  const save = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/goals/north-star/${encodeURIComponent(snapshotId)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({
            value: parseFloat(value),
            label: label.trim(),
            unit: unit.trim() || null,
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
  }, [canSubmit, submitting, snapshotId, value, label, unit, onChanged]);

  const remove = useCallback(async () => {
    if (submitting) return;
    if (!window.confirm("Delete this North Star snapshot?")) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/goals/north-star/${encodeURIComponent(snapshotId)}`,
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
  }, [submitting, snapshotId, onChanged]);

  if (!isAdmin) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`manage-north-star-open-${snapshotId}`}
        onClick={() => setOpen(true)}
        className="text-xs"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Manage
      </button>
    );
  }

  return (
    <form
      onSubmit={save}
      data-testid={`manage-north-star-form-${snapshotId}`}
      className="rounded-md border p-2 space-y-2"
      style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          data-testid={`manage-north-star-label-${snapshotId}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          className="text-sm rounded-md border px-2 py-1"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <input
          data-testid={`manage-north-star-value-${snapshotId}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          inputMode="decimal"
          className="text-sm rounded-md border px-2 py-1"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <input
          data-testid={`manage-north-star-unit-${snapshotId}`}
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="Unit"
          className="text-sm rounded-md border px-2 py-1"
          style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
      </div>
      {error && (
        <p data-testid={`manage-north-star-error-${snapshotId}`} className="text-xs" style={{ color: "var(--wp-warning)" }}>
          {error}
        </p>
      )}
      <div className="flex gap-2 items-center">
        <button
          type="submit"
          data-testid={`manage-north-star-save-${snapshotId}`}
          disabled={!canSubmit || submitting}
          className="px-3 py-1 rounded text-xs font-semibold disabled:opacity-50"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {submitting ? "…" : "Save"}
        </button>
        <button
          type="button"
          data-testid={`manage-north-star-delete-${snapshotId}`}
          onClick={remove}
          disabled={submitting}
          className="px-3 py-1 rounded text-xs font-semibold disabled:opacity-50"
          style={{ background: "var(--wp-warning)", color: "var(--wp-dark)" }}
        >
          Delete
        </button>
        <button
          type="button"
          data-testid={`manage-north-star-cancel-${snapshotId}`}
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
