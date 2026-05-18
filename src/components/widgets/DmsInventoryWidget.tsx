/**
 * DmsInventoryWidget — renders a grid of DMS inventory cards inline
 * in chat. Data comes from the AgenticQA browser-driver bridge
 * (Vibium/Playwright scraping a real dealer site).
 *
 * Pure render component: vendor-neutral shape, no fetch of its own.
 * Each row is clickable into the source DMS detail page.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { DmsInventoryWidgetSpec } from "@/lib/assistant/widgets/types";

function formatPrice(p: number | null): string {
  if (p === null) return "—";
  return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export interface DmsInventoryWidgetProps {
  spec: DmsInventoryWidgetSpec;
  workflowId?: string;
}

export function DmsInventoryWidget({ spec, workflowId }: DmsInventoryWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "dms_inventory",
          vendor: spec.vendor,
          item_count: spec.items.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.vendor, spec.items.length, workflowId]);

  function trackInteraction(action: string, vin?: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "dms_inventory",
          action,
          vendor: spec.vendor,
          vin,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  return (
    <div
      data-testid="dms-inventory-widget"
      className="mt-2 rounded-md p-3 min-w-0 max-w-full overflow-hidden"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="mb-2">
        <div className="flex items-start justify-between gap-3">
          <div
            className="text-sm font-semibold"
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            {spec.title}
          </div>
          <span
            className="text-[10px] uppercase tracking-wider whitespace-nowrap"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            via {spec.vendor}
          </span>
        </div>
        {spec.subtitle && (
          <div
            className="text-xs mt-0.5"
            style={{ color: "var(--wp-text-dim, #aaa)" }}
          >
            {spec.subtitle}
          </div>
        )}
      </div>

      {spec.items.length === 0 ? (
        <div
          data-testid="dms-inventory-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          No vehicles matched.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {spec.items.map((item, i) => (
            <li
              key={item.vin ?? `${item.title}-${i}`}
              data-testid={`dms-inventory-item-${item.vin ?? i}`}
              className="text-xs rounded p-2"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              {item.detailUrl ? (
                <a
                  href={item.detailUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={() => trackInteraction("open_vehicle_detail", item.vin ?? undefined)}
                  className="block hover:underline"
                  style={{ color: "var(--wp-text, #eee)" }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="font-semibold truncate">{item.title}</div>
                    <div
                      className="whitespace-nowrap font-medium"
                      style={{ color: "var(--wp-gold, #eab308)" }}
                    >
                      {formatPrice(item.price)}
                    </div>
                  </div>
                  {item.vin && (
                    <div
                      className="text-[10px] mt-0.5 font-mono truncate"
                      style={{ color: "var(--wp-text-muted, #6b7280)" }}
                    >
                      VIN {item.vin}
                    </div>
                  )}
                </a>
              ) : (
                <div style={{ color: "var(--wp-text, #eee)" }}>
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="font-semibold truncate">{item.title}</div>
                    <div
                      className="whitespace-nowrap font-medium"
                      style={{ color: "var(--wp-gold, #eab308)" }}
                    >
                      {formatPrice(item.price)}
                    </div>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
