/**
 * CrossToolInsightsWidget — renders a ranked list of cross-tool
 * insights inline in chat. Same visual template as the other tool
 * widgets (state-color dot, source badges, click-through action).
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { CrossToolInsightsWidgetSpec } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

function severityColor(sev: string): string {
  switch (sev) {
    case "high":
      return "var(--wp-error, #dc2626)";
    case "medium":
      return "var(--wp-warning, #eab308)";
    default:
      return "var(--wp-text-muted, #6b7280)";
  }
}

export interface CrossToolInsightsWidgetProps {
  spec: CrossToolInsightsWidgetSpec;
  workflowId?: string;
}

export function CrossToolInsightsWidget({
  spec,
  workflowId,
}: CrossToolInsightsWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "cross_tool_insights",
          insight_count: spec.items.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.items.length, workflowId]);

  useStaggeredReveal({
    widgetKind: "cross_tool_insights",
    itemCount: spec.items.length,
    workflowId,
  });

  function trackInteraction(
    action: string,
    insightId: string | undefined,
    e?: React.MouseEvent,
  ) {
    e?.stopPropagation();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "cross_tool_insights",
          action,
          insight_id: insightId,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  return (
    <div
      data-testid="cross-tool-insights-widget"
      className="mt-2 rounded-md p-3 min-w-0 max-w-full overflow-hidden"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="mb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm font-semibold" style={{ color: "var(--wp-gold, #eab308)" }}>
            {spec.title}
          </div>
          <span
            className="text-[10px] uppercase tracking-wider whitespace-nowrap"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            cross-tool
          </span>
        </div>
        {spec.subtitle && (
          <div className="text-xs mt-0.5" style={{ color: "var(--wp-text-dim, #aaa)" }}>
            {spec.subtitle}
          </div>
        )}
      </div>

      {spec.items.length === 0 ? (
        <div
          data-testid="cross-tool-insights-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          Nothing crossed the signal threshold.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {spec.items.map((item, i) => (
            <StaggeredItem
              key={item.id}
              index={i}
              data-testid={`cross-tool-insight-${item.id}`}
              className="text-xs rounded p-2"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ background: severityColor(item.severity) }}
                    aria-label={`severity ${item.severity}`}
                  />
                  <span className="font-semibold truncate" style={{ color: "var(--wp-text, #eee)" }}>
                    {item.title}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {item.sources.map((s) => (
                    <span
                      key={s}
                      className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--wp-dark-surface2, #1a1a1a)",
                        color: "var(--wp-text-muted, #6b7280)",
                        border: "1px solid var(--wp-dark-border, #333)",
                      }}
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              {item.detail && (
                <div className="text-[11px] mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                  {item.detail}
                </div>
              )}
              {item.action && (
                <div className="mt-1.5">
                  {item.action.href ? (
                    <a
                      href={item.action.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={(e) => trackInteraction("open_action", item.id, e)}
                      className="text-[11px] underline"
                      style={{ color: "var(--wp-gold, #eab308)" }}
                    >
                      {item.action.label} →
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => trackInteraction("chip_clicked", item.id, e)}
                      data-chip={item.action.chip}
                      className="text-[11px] underline"
                      style={{
                        color: "var(--wp-gold, #eab308)",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      {item.action.label}
                    </button>
                  )}
                </div>
              )}
            </StaggeredItem>
          ))}
        </ul>
      )}
    </div>
  );
}
