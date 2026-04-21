"use client";

/**
 * CaptureNorthStarForm — admin-only (ceo/cto) form to capture a
 * North Star metric snapshot. Same pattern as CreateOkrForm: closes
 * the "seed via API" gap.
 *
 * Fires goal.north_star_ui_updated via POST /api/goals/north-star;
 * trackEvent triple-writes to PG + Qdrant + Neo4j.
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface Props {
  userRole: string | null;
  onCaptured: () => void;
  /** Label for the trigger button. Defaults to "Update North Star". */
  triggerLabel?: string;
}

export default function CaptureNorthStarForm({
  userRole,
  onCaptured,
  triggerLabel = "Update North Star",
}: Props) {
  const isAdmin = userRole === "ceo" || userRole === "cto";
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    label.trim().length > 0 &&
    value.trim().length > 0 &&
    Number.isFinite(parseFloat(value));

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetchWithRefresh("/api/goals/north-star", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            label: label.trim(),
            value: parseFloat(value),
            unit: unit.trim() || undefined,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(typeof body.error === "string" ? body.error : "Failed to capture");
          setSubmitting(false);
          return;
        }
        setLabel("");
        setValue("");
        setUnit("");
        setOpen(false);
        setSubmitting(false);
        onCaptured();
      } catch {
        setError("Network error");
        setSubmitting(false);
      }
    },
    [canSubmit, submitting, label, value, unit, onCaptured],
  );

  if (!isAdmin) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-testid="capture-north-star-open"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded text-sm font-semibold transition-colors"
        style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
      >
        {triggerLabel}
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="capture-north-star-form"
      className="rounded-lg border p-3 space-y-2"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input
          data-testid="capture-north-star-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. MRR)"
          className="text-sm rounded-md border px-2 py-1"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <input
          data-testid="capture-north-star-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          inputMode="decimal"
          className="text-sm rounded-md border px-2 py-1"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
        <input
          data-testid="capture-north-star-unit"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="Unit (optional)"
          className="text-sm rounded-md border px-2 py-1"
          style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
        />
      </div>
      {error && (
        <p data-testid="capture-north-star-error" className="text-xs" style={{ color: "var(--wp-warning)" }}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="capture-north-star-submit"
          disabled={!canSubmit || submitting}
          className="px-3 py-1 rounded text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {submitting ? "Capturing…" : "Capture"}
        </button>
        <button
          type="button"
          data-testid="capture-north-star-cancel"
          onClick={() => setOpen(false)}
          className="text-xs"
          style={{ color: "var(--wp-text-dim)" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
