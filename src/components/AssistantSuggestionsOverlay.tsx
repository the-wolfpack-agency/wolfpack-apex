/**
 * AssistantSuggestionsOverlay — persistent re-entry point for the
 * starter prompts. The default chat surface shows AssistantStarter-
 * Prompts inline ONCE; after the first message they vanish. Users
 * (especially non-power users on the 7-person team) lose any
 * discoverability for what widgets / integrations / prompts exist.
 *
 * This overlay re-uses the same AssistantStarterPrompts component
 * so the prompt list, role-gating, and connector-status filtering
 * stay single-sourced. It adds:
 *   - role=dialog + aria-modal + aria-labeledby
 *   - Escape key closes
 *   - Click outside the panel closes
 *   - Focus restored to the previously-focused element on close
 *   - Initial focus on the close button (predictable; doesn't steal
 *     focus from a chip the user is mid-click on)
 *   - Analytics: assistant.suggestions_opened on mount + an
 *     assistant.suggestions_dismissed on close with the dismiss reason
 *
 * Trigger source is passed in by the parent so the analytics row
 * can distinguish "header button" vs "slash command" — useful for
 * learning which entry point users actually reach for.
 */

"use client";

import { useEffect, useRef } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { AssistantStarterPrompts } from "@/components/AssistantStarterPrompts";

export type SuggestionsTriggerSource = "header_button" | "slash_command";

export interface AssistantSuggestionsOverlayProps {
  open: boolean;
  /** Where the open request came from — used for analytics. */
  source: SuggestionsTriggerSource;
  /** Fired when a prompt chip is clicked. Parent populates the
   *  composer + closes the overlay. */
  onPickPrompt: (prompt: string) => void;
  /** Called when the user dismisses (escape / outside-click / close
   *  button). Parent should setOpen(false). */
  onClose: (reason: "escape" | "outside_click" | "close_button") => void;
}

export function AssistantSuggestionsOverlay({
  open,
  source,
  onPickPrompt,
  onClose,
}: AssistantSuggestionsOverlayProps) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  /* Mount-time analytics. Fires once per open so re-renders while
   * the overlay is visible don't double-count. */
  useEffect(() => {
    if (!open) return;
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.suggestions_opened",
        metadata: { source },
      }),
    }).catch(() => undefined);
  }, [open, source]);

  /* Escape-key listener. Bound to document so it fires regardless of
   * which element inside the overlay currently has focus. */
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose("escape");
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /* Focus management — remember what was focused before open, focus
   * the close button on open, restore prior focus on close. */
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      (typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null) ?? null;
    /* Defer one tick so the dialog has mounted. */
    const id = setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => {
      clearTimeout(id);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  function handlePick(prompt: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.suggestion_picked_from_overlay",
        metadata: { source, prompt },
      }),
    }).catch(() => undefined);
    onPickPrompt(prompt);
  }

  return (
    <div
      data-testid="assistant-suggestions-overlay-backdrop"
      onClick={() => onClose("outside_click")}
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 px-4 pt-12 sm:pt-20 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labeledby="assistant-suggestions-title"
    >
      <div
        data-testid="assistant-suggestions-overlay"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl p-5 shadow-2xl mb-12"
        style={{
          background: "var(--wp-dark-surface2, #1a1a1a)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2
              id="assistant-suggestions-title"
              className="text-lg font-semibold"
              style={{ color: "var(--wp-gold, #eab308)" }}
            >
              What can I help you with?
            </h2>
            <p
              className="text-xs mt-0.5"
              style={{ color: "var(--wp-text-dim, #aaa)" }}
            >
              Tap a prompt to run it. Categories reflect your connected
              integrations.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={() => onClose("close_button")}
            data-testid="assistant-suggestions-overlay-close"
            className="p-1 rounded transition-colors hover:opacity-80"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
            aria-label="Close suggestions"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <AssistantStarterPrompts onPick={handlePick} />
      </div>
    </div>
  );
}
