"use client";

/**
 * /emails — styled "discard unsaved draft?" confirmation dialog.
 *
 * Replaces the previous `window.confirm("...")` shim that broke the
 * Wolfpack dark theme and could not be styled or instrumented. This
 * component:
 *
 *   - Renders nothing when `open === false` (server-rendered initial
 *     paint stays inert).
 *   - Centres a modal overlay above the rest of the surface
 *     (z-index 1000+), clicks on the backdrop count as "cancel".
 *   - Auto-focuses "Keep editing" so a stray Enter never destroys
 *     work.
 *   - Closes on Esc (also a cancel).
 *   - Optionally renders a 2-line preview of the in-progress draft
 *     so the user can recall what they were writing.
 *
 * Styling matches EmptyState's vocabulary: inline styles +
 * `var(--wp-*)` tokens — no Tailwind, no design-system import.
 *
 * Analytics: the page-level caller emits
 * `insight.email.unsaved_draft_dialog_shown` and
 * `insight.email.unsaved_draft_dialog_resolved`. This component does
 * not fire its own events — keeping the dialog itself dumb makes it
 * trivially reusable elsewhere on the email surface.
 */

import { useEffect, useRef } from "react";
import type React from "react";

interface UnsavedDraftDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional 2-line preview of the in-progress draft. */
  draftPreview?: string;
}

export default function UnsavedDraftDialog({
  open,
  onConfirm,
  onCancel,
  draftPreview,
}: UnsavedDraftDialogProps) {
  const keepBtnRef = useRef<HTMLButtonElement | null>(null);

  // Auto-focus "Keep editing" when the dialog opens. This makes Enter
  // a no-destruction default.
  useEffect(() => {
    if (!open) return;
    keepBtnRef.current?.focus();
  }, [open]);

  // Esc dismisses as cancel. Bound while open only.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const titleId = "unsaved-draft-dialog-title";

  return (
    <div
      style={backdrop}
      data-testid="unsaved-draft-backdrop"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="unsaved-draft-dialog"
        style={card}
        onClick={(e) => {
          // Clicks inside the card stay inside — only backdrop cancels.
          e.stopPropagation();
        }}
      >
        <h2 id={titleId} style={heading}>
          Discard unsaved draft?
        </h2>
        <p style={body}>You&apos;ll lose what you&apos;ve written so far.</p>
        {draftPreview ? (
          <div
            style={preview}
            data-testid="unsaved-draft-preview"
            aria-label="Draft preview"
          >
            {draftPreview}
          </div>
        ) : null}
        <div style={actions}>
          <button
            ref={keepBtnRef}
            type="button"
            onClick={onCancel}
            style={secondaryBtn}
            data-testid="unsaved-draft-keep"
          >
            Keep editing
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={dangerBtn}
            data-testid="unsaved-draft-discard"
          >
            Discard draft
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles — inline + var(--wp-*) tokens to match EmptyState / page.tsx.
// ---------------------------------------------------------------------------

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "1rem",
};

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 8,
  padding: "1.25rem 1.25rem 1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  color: "var(--wp-text)",
  boxShadow: "0 12px 48px rgba(0, 0, 0, 0.6)",
};

const heading: React.CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  fontWeight: 700,
  color: "var(--wp-text)",
};

const body: React.CSSProperties = {
  margin: 0,
  fontSize: "0.88rem",
  color: "var(--wp-text-dim)",
  lineHeight: 1.45,
};

const preview: React.CSSProperties = {
  margin: 0,
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 6,
  padding: "0.5rem 0.65rem",
  fontSize: "0.78rem",
  color: "var(--wp-text-dim)",
  lineHeight: 1.4,
  maxHeight: "2.8em",
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const actions: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  justifyContent: "flex-end",
  gap: "0.5rem",
  marginTop: "0.25rem",
};

const secondaryBtn: React.CSSProperties = {
  background: "var(--wp-dark-surface2)",
  color: "var(--wp-text)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 6,
  padding: "0.45rem 0.9rem",
  fontSize: "0.82rem",
  fontWeight: 600,
  cursor: "pointer",
};

const dangerBtn: React.CSSProperties = {
  background: "transparent",
  color: "#ff6b6b",
  border: "1px solid #ff6b6b55",
  borderRadius: 6,
  padding: "0.45rem 0.9rem",
  fontSize: "0.82rem",
  fontWeight: 700,
  cursor: "pointer",
};
