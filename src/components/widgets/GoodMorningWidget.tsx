/**
 * GoodMorningWidget — inline chat version of the dashboard's
 * "Good morning" panel. Same data shape (greeting, schedule, action
 * items), trimmed to the at-a-glance trio.
 */

"use client";

import { useEffect } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type {
  GoodMorningWidgetSpec,
  GoodMorningActionItem,
} from "@/lib/assistant/widgets/types";

const PRIORITY_STYLES: Record<
  GoodMorningActionItem["priority"],
  { bg: string; color: string; label: string }
> = {
  high: { bg: "rgba(239, 68, 68, 0.15)", color: "#f87171", label: "High" },
  medium: { bg: "rgba(234, 179, 8, 0.15)", color: "var(--wp-warning, #eab308)", label: "Med" },
  low: { bg: "rgba(107, 114, 128, 0.15)", color: "var(--wp-text-muted, #9ca3af)", label: "Low" },
};

function formatTimeRange(start: string, end: string): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${fmt(start)} - ${fmt(end)}`;
}

export interface GoodMorningWidgetProps {
  spec: GoodMorningWidgetSpec;
}

export function GoodMorningWidget({ spec }: GoodMorningWidgetProps) {
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "good_morning",
          event_count: spec.schedule.events.length,
          action_count: spec.actionItems.length,
          connected: spec.connected,
        },
      }),
    }).catch(() => undefined);
  }, [spec.schedule.events.length, spec.actionItems.length, spec.connected]);

  function trackInteraction(action: string, meta: Record<string, unknown> = {}) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: { widget_kind: "good_morning", action, ...meta },
      }),
    }).catch(() => undefined);
  }

  return (
    <div
      data-testid="good-morning-widget"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div
            className="text-sm font-semibold truncate"
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            {spec.greeting}
          </div>
          <div
            className="text-xs mt-0.5"
            style={{ color: "var(--wp-text-dim, #aaa)" }}
          >
            {spec.summary}
          </div>
        </div>
        <a
          href="/"
          onClick={() => trackInteraction("open_dashboard")}
          className="text-xs whitespace-nowrap"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          Open dashboard
        </a>
      </div>

      {/* Today's schedule */}
      <div
        className="rounded-md p-2 mt-2"
        style={{
          background: "var(--wp-dark, #111)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        <div
          className="text-xs font-semibold mb-1"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          Today&apos;s Schedule
          {spec.schedule.eventCount > 0 && (
            <span className="ml-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              ({spec.schedule.eventCount})
            </span>
          )}
        </div>
        {spec.schedule.events.length === 0 ? (
          <div
            data-testid="good-morning-schedule-empty"
            className="text-xs"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            No meetings scheduled today.
          </div>
        ) : (
          <ul className="space-y-1">
            {spec.schedule.events.slice(0, 5).map((e, i) => (
              <li
                key={`${e.subject}-${i}`}
                data-testid={`good-morning-event-${i}`}
                className="text-xs"
              >
                <div
                  className="font-medium truncate"
                  style={{ color: "var(--wp-text, #eee)" }}
                >
                  {e.subject}
                </div>
                <div
                  className="flex items-center flex-wrap gap-x-2 gap-y-0.5"
                  style={{ color: "var(--wp-text-muted, #6b7280)" }}
                >
                  <span className="whitespace-nowrap">
                    {formatTimeRange(e.startTime, e.endTime)}
                  </span>
                  {e.location && <span className="truncate max-w-full">· {e.location}</span>}
                  {e.attendees.length > 0 && (
                    <span>
                      · {e.attendees.length} {e.attendees.length === 1 ? "attendee" : "attendees"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Action items */}
      <div
        className="rounded-md p-2 mt-2"
        style={{
          background: "var(--wp-dark, #111)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        <div
          className="text-xs font-semibold mb-1"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          Action Items
          {spec.actionItems.length > 0 && (
            <span className="ml-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              ({spec.actionItems.length})
            </span>
          )}
        </div>
        {spec.actionItems.length === 0 ? (
          <div
            data-testid="good-morning-actions-empty"
            className="text-xs"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            Nothing urgent. You&apos;re clear.
          </div>
        ) : (
          <ul className="space-y-1">
            {spec.actionItems.slice(0, 8).map((a, i) => {
              const style = PRIORITY_STYLES[a.priority];
              const Tag = a.link ? "a" : "div";
              const external = a.link?.startsWith("http");
              const props = a.link
                ? {
                    href: a.link,
                    onClick: () => trackInteraction("open_action_item", { source: a.source }),
                    ...(external ? { target: "_blank", rel: "noreferrer noopener" } : {}),
                  }
                : {};
              return (
                <li
                  key={`${a.text}-${i}`}
                  data-testid={`good-morning-action-${i}`}
                  className="text-xs flex items-start gap-2"
                >
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px] font-semibold flex-none mt-0.5"
                    style={{ background: style.bg, color: style.color }}
                  >
                    {style.label}
                  </span>
                  <Tag
                    {...props}
                    className="flex-1 min-w-0"
                    style={{
                      color: a.link
                        ? "var(--wp-gold, #eab308)"
                        : "var(--wp-text, #eee)",
                    }}
                  >
                    <div className="truncate">{a.text}</div>
                    {a.context && (
                      <div
                        className="truncate"
                        style={{ color: "var(--wp-text-muted, #6b7280)" }}
                      >
                        {a.context}
                      </div>
                    )}
                  </Tag>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!spec.connected && (
        <div
          data-testid="good-morning-disconnected"
          className="mt-2 text-xs"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          Connect Microsoft 365 from{" "}
          <a
            href="/settings"
            onClick={() => trackInteraction("open_settings")}
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            Settings
          </a>{" "}
          to populate this panel with live data.
        </div>
      )}
    </div>
  );
}
