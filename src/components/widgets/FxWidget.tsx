/**
 * FxWidget — table of FX rates for the `fx` empty-state demo tool.
 * Pure render over FxWidgetSpec from the handler.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { FxWidgetSpec } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

export interface FxWidgetProps {
  spec: FxWidgetSpec;
  workflowId?: string;
}

export function FxWidget({ spec, workflowId }: FxWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "fx",
          base: spec.base,
          rate_count: spec.rates.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.base, spec.rates.length, workflowId]);

  useStaggeredReveal({
    widgetKind: "fx",
    itemCount: spec.rates.length,
    workflowId,
  });

  return (
    <div
      data-testid="fx-widget"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <div
          className="text-sm font-semibold"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          Exchange rates — base {spec.base}
        </div>
        <div
          className="text-[10px] uppercase tracking-wider"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          as of {spec.asOf}
        </div>
      </div>

      {spec.rates.length === 0 ? (
        <div
          data-testid="fx-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          No FX rates available right now.
        </div>
      ) : (
        <table
          className="w-full text-xs"
          data-testid="fx-table"
          style={{ color: "var(--wp-text, #eee)" }}
        >
          <thead>
            <tr style={{ color: "var(--wp-text-dim, #aaa)" }}>
              <th className="text-left font-medium pb-1">Currency</th>
              <th className="text-right font-medium pb-1">
                1 {spec.base} =
              </th>
            </tr>
          </thead>
          <tbody>
            {spec.rates.map((r, i) => (
              <StaggeredItem
                as="tr"
                key={r.code}
                index={i}
                data-testid={`fx-row-${r.code}`}
              >
                <td className="py-0.5 font-mono">{r.code}</td>
                <td className="py-0.5 text-right font-mono">
                  {r.value.toFixed(4)}
                </td>
              </StaggeredItem>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
