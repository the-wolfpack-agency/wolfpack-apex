/**
 * IntegrationsListWidget — discoverability surface that lists every
 * integration the assistant knows about, auto-discovered from the
 * search-provider + tool registries.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { IntegrationsListWidgetSpec } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

export interface IntegrationsListWidgetProps {
  spec: IntegrationsListWidgetSpec;
  workflowId?: string;
}

export function IntegrationsListWidget({
  spec,
  workflowId,
}: IntegrationsListWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "integrations_list",
          integration_count: spec.items.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.items.length, workflowId]);

  useStaggeredReveal({
    widgetKind: "integrations_list",
    itemCount: spec.items.length,
    workflowId,
  });

  function trackInteraction(
    action: string,
    integrationId: string | undefined,
    e?: React.MouseEvent,
  ) {
    e?.stopPropagation();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "integrations_list",
          action,
          integration_id: integrationId,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  // Group by category for visual organization
  const byCategory: Record<string, typeof spec.items> = {};
  for (const it of spec.items) {
    if (!byCategory[it.category]) byCategory[it.category] = [];
    byCategory[it.category].push(it);
  }
  const categories = Object.keys(byCategory).sort();

  return (
    <div
      data-testid="integrations-list-widget"
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
            assistant catalog
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
          data-testid="integrations-list-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          No integrations registered.
        </div>
      ) : (
        <div className="space-y-3">
          {categories.map((cat) => (
            <div key={cat}>
              <div
                className="text-[10px] uppercase tracking-wider mb-1"
                style={{ color: "var(--wp-text-muted, #6b7280)" }}
              >
                {cat}
              </div>
              <ul className="space-y-1.5">
                {byCategory[cat].map((item, i) => (
                  <StaggeredItem
                    key={item.id}
                    index={i}
                    data-testid={`integration-item-${item.id}`}
                    className="text-xs rounded p-2"
                    style={{
                      background: "var(--wp-dark, #111)",
                      border: "1px solid var(--wp-dark-border, #333)",
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-semibold truncate" style={{ color: "var(--wp-text, #eee)" }}>
                        {item.name}
                      </span>
                      <span
                        className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                        style={{
                          background: "var(--wp-dark-surface2, #1a1a1a)",
                          color: "var(--wp-text-muted, #6b7280)",
                          border: "1px solid var(--wp-dark-border, #333)",
                        }}
                      >
                        {item.surface}
                      </span>
                    </div>
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={(e) => trackInteraction("sample_query_clicked", item.id, e)}
                        data-chip={item.sampleQuery}
                        className="text-[11px] underline truncate"
                        style={{
                          color: "var(--wp-gold, #eab308)",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        Try: {item.sampleQuery}
                      </button>
                    </div>
                  </StaggeredItem>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
