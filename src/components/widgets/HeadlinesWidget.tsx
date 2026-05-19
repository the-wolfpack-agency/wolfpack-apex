/**
 * HeadlinesWidget — vertical list of clickable news cards. Pure render
 * over HeadlinesWidgetSpec from the `headlines` tool.
 *
 * Each row opens in a new tab via target="_blank" + rel safety
 * attributes; clicks fire `assistant.widget_interaction` so the
 * learning loop sees which headlines actually pull users out of chat.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { HeadlinesWidgetSpec } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

function formatPublished(iso: string): string {
  if (!iso) return "";
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return iso.slice(0, 16);
  const diff = Date.now() - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(d).toLocaleDateString("default", { month: "short", day: "numeric" });
}

export interface HeadlinesWidgetProps {
  spec: HeadlinesWidgetSpec;
  workflowId?: string;
}

export function HeadlinesWidget({ spec, workflowId }: HeadlinesWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "headlines",
          item_count: spec.items.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.items.length, workflowId]);

  useStaggeredReveal({
    widgetKind: "headlines",
    itemCount: spec.items.length,
    workflowId,
  });

  function trackInteraction(action: string, link?: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "headlines",
          action,
          link,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  return (
    <div
      data-testid="headlines-widget"
      className="mt-2 rounded-md p-3"
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
        {spec.subtitle && (
          <div
            className="text-xs mt-0.5"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            {spec.subtitle}
          </div>
        )}
      </div>

      {spec.items.length === 0 ? (
        <div
          data-testid="headlines-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          No headlines available right now.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {spec.items.map((item, i) => (
            <StaggeredItem
              key={`${item.link}-${i}`}
              index={i}
              data-testid={`headlines-item-${i}`}
              className="text-xs rounded p-2"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <a
                href={item.link}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => trackInteraction("open_headline", item.link)}
                className="block hover:underline"
                style={{ color: "var(--wp-text, #eee)" }}
              >
                <div className="font-semibold leading-snug">{item.title}</div>
                <div
                  className="text-[10px] mt-0.5 uppercase tracking-wider"
                  style={{ color: "var(--wp-text-muted, #6b7280)" }}
                >
                  {item.source}
                  {item.published && ` · ${formatPublished(item.published)}`}
                </div>
              </a>
            </StaggeredItem>
          ))}
        </ul>
      )}
    </div>
  );
}
