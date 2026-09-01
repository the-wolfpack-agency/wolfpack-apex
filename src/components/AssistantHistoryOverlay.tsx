/**
 * AssistantHistoryOverlay — surfaces the user's recent submitted
 * prompts so they can re-run, edit, or just remember how they
 * phrased something. Mirrors AssistantSuggestionsOverlay's a11y
 * pattern: role=dialog, aria-modal, Escape closes, click-outside
 * closes, initial focus on the close button, focus restored on
 * close.
 *
 * Behavior on pick: fills the composer with the chosen prompt and
 * closes the overlay. We deliberately do NOT auto-send — Nick's
 * design intent was "let the user edit before re-sending."
 *
 * Data source: GET /api/assistant/prompt-history (paginated, deduped
 * by the route). We fetch on every open so a user who just sent a
 * message and reopens immediately sees it. Cheap query — short and
 * indexed on (conversation_id, role, created_at).
 *
 * Trigger source is passed in by the parent so analytics distinguish
 * "header_button" vs "slash_command", matching the suggestions
 * overlay convention.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authHeaders, fetchWithRefresh } from "@/lib/client-auth";

export type HistoryTriggerSource = "header_button" | "slash_command";

export interface AssistantHistoryItem {
  content: string;
  last_asked_at: string;
  ask_count: number;
}

export interface AssistantHistoryOverlayProps {
  open: boolean;
  source: HistoryTriggerSource;
  /** Fired when a prompt row is clicked. Parent populates the
   *  composer + closes the overlay; pick is non-destructive (no
   *  auto-submit). */
  onPickPrompt: (prompt: string) => void;
  onClose: (reason: "escape" | "outside_click" | "close_button") => void;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function AssistantHistoryOverlay({
  open,
  source,
  onPickPrompt,
  onClose,
}: AssistantHistoryOverlayProps) {
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [items, setItems] = useState<AssistantHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  /* Fetch prompt history on open. We re-fetch every time so the
   * overlay reflects the latest send. The route is cheap + degrades
   * to an empty list on failure. */
  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setErrored(false);
    try {
      const res = await fetchWithRefresh(
        "/api/assistant/prompt-history?limit=25",
        { headers: authHeaders() },
      );
      if (!res.ok) {
        setItems([]);
        setErrored(true);
        return;
      }
      const data = (await res.json()) as { prompts?: AssistantHistoryItem[] };
      setItems(Array.isArray(data.prompts) ? data.prompts : []);
    } catch {
      setItems([]);
      setErrored(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.history_opened",
        metadata: { source },
      }),
    }).catch(() => undefined);
    void fetchHistory();
  }, [open, source, fetchHistory]);

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

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      (typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null) ?? null;
    const id = setTimeout(() => closeBtnRef.current?.focus(), 0);
    return () => {
      clearTimeout(id);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  function handlePick(item: AssistantHistoryItem) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.history_picked",
        metadata: { source, ask_count: item.ask_count },
      }),
    }).catch(() => undefined);
    onPickPrompt(item.content);
  }

  return (
    <div
      data-testid="assistant-history-overlay-backdrop"
      onClick={() => onClose("outside_click")}
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 px-4 pt-12 sm:pt-20 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labeledby="assistant-history-title"
    >
      <div
        data-testid="assistant-history-overlay"
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
              id="assistant-history-title"
              className="text-lg font-semibold"
              style={{ color: "var(--wp-gold, #eab308)" }}
            >
              Your recent prompts
            </h2>
            <p
              className="text-xs mt-0.5"
              style={{ color: "var(--wp-text-dim, #aaa)" }}
            >
              Tap a prompt to load it into the composer. Edit before sending,
              or send as-is.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={() => onClose("close_button")}
            data-testid="assistant-history-overlay-close"
            className="p-1 rounded transition-colors hover:opacity-80"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
            aria-label="Close prompt history"
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

        {loading && (
          <div
            data-testid="assistant-history-loading"
            className="text-sm py-6 text-center"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            Loading…
          </div>
        )}

        {!loading && errored && (
          <div
            data-testid="assistant-history-error"
            className="text-sm py-6 text-center"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            Couldn&apos;t load prompt history. Try again in a moment.
          </div>
        )}

        {!loading && !errored && items.length === 0 && (
          <div
            data-testid="assistant-history-empty"
            className="text-sm py-6 text-center"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            No prompts yet. Once you ask the assistant something, it&apos;ll
            show up here for easy reuse.
          </div>
        )}

        {!loading && !errored && items.length > 0 && (
          <ul
            data-testid="assistant-history-list"
            className="flex flex-col gap-1"
          >
            {items.map((item, idx) => (
              <li key={`${idx}-${item.last_asked_at}`}>
                <button
                  type="button"
                  data-testid={`assistant-history-item-${idx}`}
                  onClick={() => handlePick(item)}
                  className="w-full text-left flex items-start gap-3 px-3 py-2 rounded-lg transition-colors hover:opacity-90"
                  style={{
                    background: "var(--wp-dark-surface, #111)",
                    border: "1px solid var(--wp-dark-border, #333)",
                  }}
                >
                  <span
                    className="flex-1 min-w-0 text-sm truncate"
                    style={{ color: "var(--wp-text, #eee)" }}
                  >
                    {item.content}
                  </span>
                  <span
                    className="shrink-0 text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--wp-text-muted, #6b7280)" }}
                  >
                    {relativeTime(item.last_asked_at)}
                    {item.ask_count > 1 ? ` · ${item.ask_count}×` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
