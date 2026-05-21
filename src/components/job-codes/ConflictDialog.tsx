"use client";

/**
 * ConflictDialog — blocking modal shown when a cell PATCH returns 409.
 *
 * Reused across:
 *   - JobCodesTable inline edit (one conflict, one column)
 *   - ReceiptUploadButton (apply runs up to 3 PATCHes; surfaces every
 *     conflict in one dialog)
 *   - ScanReceiptWidget (same as above, inline in chat)
 *
 * UX intent: tell the user exactly who set what and when, then offer
 * three exclusive choices. There is intentionally no inline "merge"
 * affordance — multi-column merging at the cell level is its own
 * feature and adds bugs more often than it removes them.
 *
 * Analytics: emits `system.job_code_conflict_resolved` with
 * `{code, columns, resolved_as}` on every dismissal so the learning
 * loop can see which path users actually take when they hit a conflict.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

export interface ConflictRow {
  /** Workbook header text — e.g. "Program" / "PO Number" / "PO Amount". */
  column: string;
  /** The value the cell holds right now (Graph pre-write read). */
  currentValue: string;
  /** What the user thought was there when they opened the editor. */
  expectedValue: string;
  /** What they tried to write. */
  requestedValue: string;
}

export type ConflictResolution = "keep_theirs" | "overwrite" | "cancel";

export interface ConflictDialogProps {
  /** Code the conflict applies to — used in the headline + analytics. */
  code: string;
  /** Every column whose PATCH came back 409. At least one row is required;
   *  pass null/empty to hide the dialog. */
  conflicts: ConflictRow[] | null;
  /** Optional human-readable hint about WHO last edited the cell — built by
   *  the caller from the audit log if available. The dialog renders it
   *  verbatim ("Hoxsie set PO Number to PO-99 18s ago."). When absent we
   *  fall back to a generic "Someone else changed this." line. */
  recentEditorHint?: string | null;
  /** Caller's callback after the user picks a resolution. We fire the
   *  resolution analytics first, then invoke this — so the analytics row
   *  hits the events table even if the caller throws. */
  onResolve: (choice: ConflictResolution) => void;
}

export function ConflictDialog({ code, conflicts, recentEditorHint, onResolve }: ConflictDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  const conflictColumns = useMemo(
    () => (conflicts ?? []).map((c) => c.column).join(","),
    [conflicts],
  );

  const fire = useCallback(
    (resolved_as: ConflictResolution) => {
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "system.job_code_conflict_resolved",
          metadata: { code, columns: conflictColumns, resolved_as },
        }),
      }).catch(() => undefined);
    },
    [code, conflictColumns],
  );

  /* Keyboard handler: Esc cancels — same as clicking the backdrop. */
  useEffect(() => {
    if (!conflicts || conflicts.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        fire("cancel");
        onResolve("cancel");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conflicts, fire, onResolve]);

  if (!conflicts || conflicts.length === 0) return null;

  const choose = (choice: ConflictResolution) => {
    fire(choice);
    onResolve(choice);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Conflict on ${code}`}
      data-testid="conflict-dialog"
      className="fixed inset-0 flex items-center justify-center z-50"
      onClick={() => choose("cancel")}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md p-5 rounded-lg space-y-3"
        style={{
          background: "var(--wp-dark-surface, #1f1f22)",
          border: "1px solid var(--wp-dark-border, #333)",
          color: "var(--wp-text, #eee)",
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1rem", color: "var(--wp-gold)" }} data-testid="conflict-dialog-title">
          Someone else just edited {code}
        </h2>

        <p
          className="text-xs"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
          data-testid="conflict-dialog-hint"
        >
          {recentEditorHint
            ? recentEditorHint
            : `${conflicts.length === 1 ? "This column was" : "These columns were"} changed between when you opened the editor and now.`}
        </p>

        <ul
          data-testid="conflict-dialog-rows"
          className="space-y-2 text-xs"
        >
          {conflicts.map((c) => (
            <li
              key={c.column}
              data-testid={`conflict-row-${c.column}`}
              className="rounded p-2"
              style={{
                background: "var(--wp-dark-surface2, #1a1a1a)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <div className="font-semibold" style={{ color: "var(--wp-text, #eee)" }}>{c.column}</div>
              <div style={{ color: "var(--wp-text-dim, #aaa)" }}>
                Their value:{" "}
                <span data-testid={`conflict-current-${c.column}`} style={{ color: "var(--wp-text, #eee)" }}>
                  {c.currentValue || "(blank)"}
                </span>
              </div>
              <div style={{ color: "var(--wp-text-dim, #aaa)" }}>
                Your value:{" "}
                <span data-testid={`conflict-requested-${c.column}`} style={{ color: "var(--wp-text, #eee)" }}>
                  {c.requestedValue || "(blank)"}
                </span>
              </div>
              {c.expectedValue !== c.currentValue && (
                <div
                  style={{ color: "var(--wp-text-muted, #6b7280)", fontSize: "10px", marginTop: "2px" }}
                >
                  When you opened the editor:{" "}
                  <code>{c.expectedValue || "(blank)"}</code>
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2 flex-wrap">
          <button
            type="button"
            data-testid="conflict-keep-theirs"
            onClick={() => choose("keep_theirs")}
            className="px-3 py-1.5 rounded text-xs"
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-text-dim, #aaa)",
              border: "1px solid var(--wp-dark-border, #333)",
              cursor: "pointer",
            }}
          >
            Keep theirs
          </button>
          <button
            type="button"
            data-testid="conflict-cancel"
            onClick={() => choose("cancel")}
            className="px-3 py-1.5 rounded text-xs"
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              color: "var(--wp-text-dim, #aaa)",
              border: "1px solid var(--wp-dark-border, #333)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="conflict-overwrite"
            onClick={() => choose("overwrite")}
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              background: "var(--wp-gold, #eab308)",
              color: "var(--wp-dark, #111)",
              border: "1px solid var(--wp-dark-border, #333)",
              cursor: "pointer",
            }}
          >
            Overwrite
          </button>
        </div>
      </div>
    </div>
  );
}
