/**
 * GithubItemsWidget — renders a list of GitHub Pull Requests OR Issues
 * inline in chat. Same visual template as VercelDeploymentsWidget for
 * consistency. State-color dot (open=green, closed=red, draft=gray),
 * repo + author + age + labels (issues only). Click-through to the
 * GitHub PR/issue page with analytics on render + interaction.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type {
  GithubItemsWidgetSpec,
  GithubItem,
} from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

function stateColor(item: GithubItem): string {
  if (item.kind === "pull_request" && item.draft) {
    return "var(--wp-text-muted, #6b7280)";
  }
  return item.state === "open"
    ? "var(--wp-success, #16a34a)"
    : "var(--wp-error, #dc2626)";
}

function stateLabel(item: GithubItem): string {
  if (item.kind === "pull_request" && item.draft) return "draft";
  return item.state;
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export interface GithubItemsWidgetProps {
  spec: GithubItemsWidgetSpec;
  workflowId?: string;
}

export function GithubItemsWidget({ spec, workflowId }: GithubItemsWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "github_items",
          item_kind: spec.itemKind,
          item_count: spec.items.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.itemKind, spec.items.length, workflowId]);

  useStaggeredReveal({
    widgetKind: "github_items",
    itemCount: spec.items.length,
    workflowId,
  });

  function trackInteraction(
    action: string,
    itemId: string | undefined,
    e?: React.MouseEvent,
  ) {
    e?.stopPropagation();
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "github_items",
          item_kind: spec.itemKind,
          action,
          item_id: itemId,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  const noun = spec.itemKind === "pull_request" ? "pull requests" : "issues";

  return (
    <div
      data-testid="github-items-widget"
      data-item-kind={spec.itemKind}
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
            via GitHub
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
          data-testid="github-items-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          No {noun} to show.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {spec.items.map((item, i) => (
            <StaggeredItem
              key={item.id}
              index={i}
              data-testid={`github-item-${item.id}`}
              className="text-xs rounded p-2"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => trackInteraction("open_github_item", item.id, e)}
                className="block hover:underline"
                style={{ color: "var(--wp-text, #eee)" }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ background: stateColor(item) }}
                      aria-label={`state ${stateLabel(item)}`}
                    />
                    <span className="font-semibold truncate">
                      {item.repo}#{item.number}
                    </span>
                    <span
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                      style={{
                        background: "var(--wp-dark-surface2, #1a1a1a)",
                        color: "var(--wp-text-muted, #6b7280)",
                        border: "1px solid var(--wp-dark-border, #333)",
                      }}
                    >
                      {stateLabel(item)}
                    </span>
                  </div>
                  <span
                    className="whitespace-nowrap text-[10px]"
                    style={{ color: "var(--wp-text-muted, #6b7280)" }}
                  >
                    {ageLabel(item.updatedAt)}
                  </span>
                </div>
                <div
                  className="text-[11px] mt-1 truncate"
                  style={{ color: "var(--wp-text-dim, #aaa)" }}
                >
                  {item.title}
                </div>
                <div
                  className="text-[10px] mt-0.5 flex items-center gap-2 flex-wrap"
                  style={{ color: "var(--wp-text-muted, #6b7280)" }}
                >
                  <span className="font-mono">@{item.user}</span>
                  {item.labels && item.labels.length > 0 && (
                    <span className="flex gap-1 flex-wrap">
                      {item.labels.slice(0, 4).map((l) => (
                        <span
                          key={l}
                          className="px-1.5 py-0.5 rounded"
                          style={{
                            background: "var(--wp-dark-surface2, #1a1a1a)",
                            border: "1px solid var(--wp-dark-border, #333)",
                          }}
                        >
                          {l}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </a>
            </StaggeredItem>
          ))}
        </ul>
      )}
    </div>
  );
}
