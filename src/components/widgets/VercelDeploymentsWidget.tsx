/**
 * VercelDeploymentsWidget — renders a list of Vercel deployment rows
 * inline in chat. Each row shows project, environment, state with
 * color, optional commit message + branch, and click-through to the
 * Vercel dashboard (or the deployed *.vercel.app URL as fallback).
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { VercelDeploymentsWidgetSpec } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

function stateColor(state: string): string {
  switch (state) {
    case "READY":
      return "var(--wp-success, #16a34a)";
    case "ERROR":
    case "CANCELED":
      return "var(--wp-error, #dc2626)";
    case "BUILDING":
    case "INITIALIZING":
    case "QUEUED":
      return "var(--wp-warning, #eab308)";
    default:
      return "var(--wp-text-muted, #6b7280)";
  }
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

export interface VercelDeploymentsWidgetProps {
  spec: VercelDeploymentsWidgetSpec;
  workflowId?: string;
}

export function VercelDeploymentsWidget({
  spec,
  workflowId,
}: VercelDeploymentsWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "vercel_deployments",
          project_name: spec.projectName,
          item_count: spec.items.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.projectName, spec.items.length, workflowId]);

  useStaggeredReveal({
    widgetKind: "vercel_deployments",
    itemCount: spec.items.length,
    workflowId,
  });

  function trackInteraction(action: string, deployId?: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "vercel_deployments",
          action,
          project_name: spec.projectName,
          deploy_id: deployId,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  return (
    <div
      data-testid="vercel-deployments-widget"
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
            via Vercel
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
          data-testid="vercel-deployments-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          No deployments to show.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {spec.items.map((item, i) => (
            <StaggeredItem
              key={item.id}
              index={i}
              data-testid={`vercel-deploy-item-${item.id}`}
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
                onClick={() => trackInteraction("open_deploy", item.id)}
                className="block hover:underline"
                style={{ color: "var(--wp-text, #eee)" }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ background: stateColor(item.state) }}
                      aria-label={`state ${item.state}`}
                    />
                    <span className="font-semibold truncate">
                      {item.projectName}
                    </span>
                    <span
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                      style={{
                        background: "var(--wp-dark-surface2, #1a1a1a)",
                        color:
                          item.target === "production"
                            ? "var(--wp-gold, #eab308)"
                            : "var(--wp-text-muted, #6b7280)",
                        border: "1px solid var(--wp-dark-border, #333)",
                      }}
                    >
                      {item.target}
                    </span>
                  </div>
                  <span
                    className="whitespace-nowrap text-[10px]"
                    style={{ color: "var(--wp-text-muted, #6b7280)" }}
                  >
                    {ageLabel(item.readyAt ?? item.createdAt)}
                  </span>
                </div>
                {(item.commitMessage || item.branch) && (
                  <div
                    className="text-[11px] mt-1 truncate"
                    style={{ color: "var(--wp-text-dim, #aaa)" }}
                  >
                    {item.branch && (
                      <span
                        className="font-mono mr-1.5"
                        style={{ color: "var(--wp-text-muted, #6b7280)" }}
                      >
                        {item.branch}
                        {item.commitSha ? ` ${item.commitSha}` : ""}
                      </span>
                    )}
                    {item.commitMessage}
                  </div>
                )}
              </a>
            </StaggeredItem>
          ))}
        </ul>
      )}
    </div>
  );
}
