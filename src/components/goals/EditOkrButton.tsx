"use client";

/**
 * EditOkrButton — admin-only inline edit of an OKR's objective + quarter.
 * PATCH /api/goals/okrs/[id]. Fires goal.okr_edited on the server.
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface Props {
  okrId: string;
  currentObjective: string;
  currentQuarter: string;
  userRole: string | null;
  onSaved: () => void;
}

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

export default function EditOkrButton({
  okrId,
  currentObjective,
  currentQuarter,
  userRole,
  onSaved,
}: Props) {
  const isAdmin = userRole === "ceo" || userRole === "cto" || userRole === "evp";
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState(currentObjective);
  const [quarter, setQuarter] = useState(currentQuarter);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed =
    objective.trim() !== currentObjective.trim() ||
    quarter.trim() !== currentQuarter.trim();
  const canSubmit =
    changed &&
    objective.trim().length > 0 &&
    QUARTER_RE.test(quarter.trim());

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetchWithRefresh(
          `/api/goals/okrs/${encodeURIComponent(okrId)}`,
          {
            method: "PATCH",
            headers: jsonHeaders(),
            body: JSON.stringify({
              objective: objective.trim(),
              quarter: quarter.trim(),
            }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(typeof body.error === "string" ? body.error : "Failed to edit");
          setSubmitting(false);
          return;
        }
        setOpen(false);
        setSubmitting(false);
        onSaved();
      } catch {
        setError("Network error");
        setSubmitting(false);
      }
    },
    [canSubmit, submitting, okrId, objective, quarter, onSaved],
  );

  if (!isAdmin) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`edit-okr-open-${okrId}`}
        onClick={() => {
          setObjective(currentObjective);
          setQuarter(currentQuarter);
          setOpen(true);
          setError(null);
        }}
        className="text-xs"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Edit
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      data-testid={`edit-okr-form-${okrId}`}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        data-testid={`edit-okr-quarter-${okrId}`}
        value={quarter}
        onChange={(e) => setQuarter(e.target.value)}
        placeholder="YYYY-QN"
        className="text-sm rounded-md border px-2 py-1 w-24"
        style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
      />
      <input
        data-testid={`edit-okr-objective-${okrId}`}
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        placeholder="Objective"
        className="text-sm rounded-md border px-2 py-1 flex-1 min-w-0"
        style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)", color: "var(--wp-text)" }}
      />
      <button
        type="submit"
        data-testid={`edit-okr-submit-${okrId}`}
        disabled={!canSubmit || submitting}
        className="px-2 py-1 rounded text-xs font-semibold disabled:opacity-50"
        style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
      >
        {submitting ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        data-testid={`edit-okr-cancel-${okrId}`}
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
          data-testid={`edit-okr-error-${okrId}`}
          className="text-xs"
          style={{ color: "var(--wp-warning)" }}
        >
          {error}
        </span>
      )}
    </form>
  );
}
