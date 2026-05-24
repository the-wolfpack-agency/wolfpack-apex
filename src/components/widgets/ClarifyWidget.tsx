/**
 * ClarifyWidget — typo / ambiguity 1-tap chip surface. Rendered when
 * the user's query looks like a near-miss for a known command. Each
 * chip click sets the chat composer to the corrected query and
 * dispatches `instinct:autosubmit` so InstinctChat re-sends.
 *
 * Zero LLM tokens to render. The bridge to the composer is a custom
 * window event so the widget stays decoupled from InstinctChat's
 * internals (same loose-coupling pattern as the `instinct:emails-
 * seen` event the EmailNavBadge listens for).
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { ClarifyWidgetSpec } from "@/lib/assistant/widgets/types";

export interface ClarifyWidgetProps {
  spec: ClarifyWidgetSpec;
  workflowId?: string;
}

export const CLARIFY_AUTOSUBMIT_EVENT = "instinct:autosubmit";

export function ClarifyWidget({ spec, workflowId }: ClarifyWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "clarify",
          suggestion_count: spec.suggestions.length,
          original_query: spec.originalQuery,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.suggestions.length, spec.originalQuery, workflowId]);

  function onPick(s: { label: string; query: string }, e: React.MouseEvent) {
    e.stopPropagation();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "clarify",
          action: "suggestion_clicked",
          original_query: spec.originalQuery,
          chosen_query: s.query,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(CLARIFY_AUTOSUBMIT_EVENT, {
          detail: { prompt: s.query },
        }),
      );
    }
  }

  return (
    <div
      data-testid="clarify-widget"
      className="mt-2 rounded-md p-3 min-w-0 max-w-full overflow-hidden"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="mb-2">
        <div
          className="text-sm font-semibold"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          {spec.title}
        </div>
        <div
          className="text-xs mt-0.5"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          You typed{" "}
          <span style={{ color: "var(--wp-text, #eee)", fontStyle: "italic" }}>
            &ldquo;{spec.originalQuery}&rdquo;
          </span>
          . Tap a suggestion to run it.
        </div>
      </div>
      <ul className="space-y-1.5">
        {spec.suggestions.map((s) => (
          <li key={s.query}>
            <button
              type="button"
              data-testid={`clarify-suggestion-${s.query.replace(/\s+/g, "-")}`}
              onClick={(e) => onPick(s, e)}
              className="w-full text-left px-3 py-2 rounded text-xs transition-colors hover:opacity-90"
              style={{
                background: "rgba(234,179,8,0.08)",
                color: "var(--wp-gold, #eab308)",
                border: "1px solid rgba(234,179,8,0.25)",
                cursor: "pointer",
              }}
            >
              <div className="font-semibold">{s.label}</div>
              {s.hint && (
                <div
                  className="text-[11px] mt-0.5"
                  style={{ color: "var(--wp-text-dim, #aaa)" }}
                >
                  {s.hint}
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
