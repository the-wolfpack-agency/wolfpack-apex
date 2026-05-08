"use client";

/**
 * ArchiveOkrButton — admin-only archive control for a company OKR.
 * DELETE /api/goals/okrs/[id] sets status='archived' so the row + its
 * contributions stay in history but drop out of active views.
 */

import { useCallback, useState } from "react";
import { fetchWithRefresh, authHeaders } from "@/lib/client-auth";

interface Props {
  okrId: string;
  userRole: string | null;
  onArchived: () => void;
}

export default function ArchiveOkrButton({ okrId, userRole, onArchived }: Props) {
  const isAdmin = userRole === "ceo" || userRole === "cto" || userRole === "evp";
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const archive = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/goals/okrs/${encodeURIComponent(okrId)}`,
        { method: "DELETE", headers: authHeaders() },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : "Failed to archive");
        setSubmitting(false);
        return;
      }
      setConfirming(false);
      setSubmitting(false);
      onArchived();
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }, [okrId, onArchived]);

  if (!isAdmin) return null;

  if (!confirming) {
    return (
      <button
        type="button"
        data-testid={`archive-okr-open-${okrId}`}
        onClick={() => setConfirming(true)}
        className="text-xs"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Archive
      </button>
    );
  }

  return (
    <div
      data-testid={`archive-okr-confirm-${okrId}`}
      className="flex items-center gap-2 text-xs"
    >
      <span style={{ color: "var(--wp-warning)" }}>Archive this OKR?</span>
      <button
        type="button"
        data-testid={`archive-okr-submit-${okrId}`}
        onClick={archive}
        disabled={submitting}
        className="px-2 py-0.5 rounded font-semibold disabled:opacity-50"
        style={{ background: "var(--wp-warning)", color: "var(--wp-dark)" }}
      >
        {submitting ? "Archiving…" : "Yes, archive"}
      </button>
      <button
        type="button"
        data-testid={`archive-okr-cancel-${okrId}`}
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
        style={{ color: "var(--wp-text-dim)" }}
      >
        Cancel
      </button>
      {error && (
        <span
          data-testid={`archive-okr-error-${okrId}`}
          style={{ color: "var(--wp-warning)" }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
