"use client";

/**
 * UpdateKrProgressForm — inline per-KR form that PATCHes current_value.
 * Any teammate can move a KR forward; the server fires goal.kr_updated
 * with the signed delta so the learning loop sees velocity.
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface Props {
  krId: string;
  currentValue: number;
  targetValue: number;
  unit: string | null;
  onUpdated: () => void;
}

export default function UpdateKrProgressForm({
  krId,
  currentValue,
  targetValue,
  unit,
  onUpdated,
}: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(currentValue));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    value.trim().length > 0 &&
    Number.isFinite(parseFloat(value)) &&
    parseFloat(value) !== currentValue;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
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
            body: JSON.stringify({ current_value: parseFloat(value) }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(typeof body.error === "string" ? body.error : "Failed to update");
          setSubmitting(false);
          return;
        }
        setOpen(false);
        setSubmitting(false);
        onUpdated();
      } catch {
        setError("Network error");
        setSubmitting(false);
      }
    },
    [canSubmit, submitting, krId, value, onUpdated],
  );

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`update-kr-open-${krId}`}
        onClick={() => {
          setValue(String(currentValue));
          setOpen(true);
        }}
        className="text-xs"
        style={{ color: "var(--wp-gold)" }}
      >
        Update progress
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid={`update-kr-form-${krId}`}
      className="flex items-center gap-2"
    >
      <label className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
        New value
      </label>
      <input
        data-testid={`update-kr-value-${krId}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        inputMode="decimal"
        className="text-sm rounded-md border px-2 py-1 w-24"
        style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
      />
      <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
        / {targetValue}
        {unit ? ` ${unit}` : ""}
      </span>
      <button
        type="submit"
        data-testid={`update-kr-submit-${krId}`}
        disabled={!canSubmit || submitting}
        className="px-2 py-1 rounded text-xs font-semibold disabled:opacity-50"
        style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
      >
        {submitting ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        data-testid={`update-kr-cancel-${krId}`}
        onClick={() => {
          setOpen(false);
          setError(null);
        }}
        className="text-xs"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Cancel
      </button>
      {error && (
        <span
          data-testid={`update-kr-error-${krId}`}
          className="text-xs"
          style={{ color: "var(--wp-warning)" }}
        >
          {error}
        </span>
      )}
    </form>
  );
}
