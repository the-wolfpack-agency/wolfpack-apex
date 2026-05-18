/**
 * EmailThreadWidget — inline list of recent emails rendered in chat.
 *
 * Pure render: data flows in via EmailThreadWidgetSpec from the tool.
 * Each row is a button (a) deep-linking to Outlook + (b) firing an
 * analytics event so the learning loop knows which surface was used.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { EmailThreadWidgetSpec } from "@/lib/assistant/widgets/types";
import { StaggeredItem, useStaggeredReveal } from "./StaggeredItem";

function formatRelative(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return "";
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

export interface EmailThreadWidgetProps {
  spec: EmailThreadWidgetSpec;
  workflowId?: string;
}

export function EmailThreadWidget({ spec, workflowId }: EmailThreadWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "email_thread",
          message_count: spec.messages.length,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.messages.length, workflowId]);

  /* Fire items_revealed once per mount alongside widget_rendered. */
  useStaggeredReveal({
    widgetKind: "email_thread",
    itemCount: spec.messages.length,
    workflowId,
  });

  function trackInteraction(action: string, messageId?: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: {
          widget_kind: "email_thread",
          action,
          message_id: messageId,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }

  return (
    <div
      data-testid="email-thread-widget"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div
        className="flex items-center justify-between mb-2"
        style={{ color: "var(--wp-text-dim, #aaa)" }}
      >
        <div>
          <div className="text-sm font-semibold">{spec.title}</div>
          {spec.subtitle && (
            <div className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              {spec.subtitle}
            </div>
          )}
        </div>
        <a
          href="/emails"
          onClick={() => trackInteraction("open_email_page")}
          className="text-xs"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          Open full inbox
        </a>
      </div>

      {spec.messages.length === 0 ? (
        <div
          data-testid="email-thread-empty"
          className="text-xs py-3 text-center"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          No emails to show.
        </div>
      ) : (
        <ul className="space-y-1">
          {spec.messages.map((m, idx) => (
            <StaggeredItem
              key={m.id}
              index={idx}
              data-testid={`email-thread-message-${m.id}`}
              className="text-xs rounded px-2 py-1.5"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div
                  className={`truncate ${m.isRead ? "" : "font-semibold"}`}
                  style={{ color: "var(--wp-text, #eee)" }}
                >
                  {m.from}
                </div>
                <span style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                  {formatRelative(m.receivedAt)}
                </span>
              </div>
              <div
                className={`truncate ${m.isRead ? "" : "font-medium"}`}
                style={{ color: "var(--wp-text, #eee)" }}
              >
                {m.subject}
              </div>
              {m.preview && (
                <div className="truncate" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                  {m.preview}
                </div>
              )}
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {m.webLink && (
                  <a
                    href={m.webLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={() => trackInteraction("open_outlook", m.id)}
                    style={{ color: "var(--wp-gold, #eab308)" }}
                  >
                    Open in Outlook
                  </a>
                )}
                {m.instinctDetailHref && (
                  <a
                    href={m.instinctDetailHref}
                    onClick={() => trackInteraction("open_in_instinct", m.id)}
                    style={{ color: "var(--wp-text-muted, #9ca3af)" }}
                  >
                    Open in Instinct
                  </a>
                )}
              </div>
            </StaggeredItem>
          ))}
        </ul>
      )}
    </div>
  );
}
