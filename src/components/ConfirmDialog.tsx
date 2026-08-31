"use client";

/**
 * ConfirmDialog — shared replacement for browser-native `confirm()`.
 *
 * Used by /discussions for thread + reply deletes. Kept deliberately
 * small (no Radix / shadcn dep) so it can be dropped into any of our
 * authenticated pages without adding runtime deps. All writes must still
 * flow through fetchWithRefresh at the call site — this component only
 * yields a boolean decision.
 *
 * Props:
 *   open          controlled visibility flag
 *   title         short heading (e.g. "Delete discussion?")
 *   body          explanatory copy / consequences
 *   onConfirm     called when the user clicks the primary action
 *   onCancel      called when the user cancels, presses Escape, or
 *                 clicks the backdrop
 *   destructive   renders the primary button in the error palette
 *   confirmLabel  override text for the primary action (default "Confirm")
 *   cancelLabel   override text for the secondary action (default "Cancel")
 */

import { useEffect, useRef } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

export default function ConfirmDialog({
  open,
  title,
  body,
  onConfirm,
  onCancel,
  destructive = false,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
}: ConfirmDialogProps) {
  const confirmBtn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Escape dismisses like the native confirm(). We bind document-level
    // so it works even when focus drifts out of the dialog tree.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", onKey);
    // Focus the destructive/primary button so Enter = confirm.
    confirmBtn.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labeledby="confirm-dialog-title"
      data-testid="confirm-dialog"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-lg border p-5 mx-4 shadow-xl"
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
          color: "var(--wp-text)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="confirm-dialog-title"
          className="text-base font-semibold mb-2"
          style={{ color: "var(--wp-gold)" }}
        >
          {title}
        </h2>
        {body && (
          <p
            className="text-sm mb-4"
            style={{ color: "var(--wp-text-dim)" }}
            data-testid="confirm-dialog-body"
          >
            {body}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
            className="px-3 py-1.5 rounded-lg text-sm font-medium"
            style={{
              background: "var(--wp-dark-surface2)",
              color: "var(--wp-text)",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmBtn}
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
            className="px-3 py-1.5 rounded-lg text-sm font-semibold"
            style={{
              background: destructive ? "var(--wp-error)" : "var(--wp-gold)",
              color: destructive ? "#fff" : "var(--wp-dark)",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
