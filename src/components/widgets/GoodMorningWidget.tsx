/**
 * GoodMorningWidget — inline chat version of the dashboard's
 * "Good morning" panel. Same data shape (greeting, schedule, action
 * items), trimmed to the at-a-glance trio.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type {
  GoodMorningWidgetSpec,
  GoodMorningActionItem,
  GoodMorningPreBriefMeeting,
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

/* Live status helpers mirrored from MeetingPreBriefPanel so the countdown
 * ticks forward without a server round-trip. Computing minutesUntil and
 * inProgress from the ISO start/end + Date.now() keeps a long-open chat
 * tab from showing stale "in 1h" labels. */
function liveStatus(
  m: GoodMorningPreBriefMeeting,
  nowMs: number,
): { minutesUntil: number | null; inProgress: boolean } {
  const startMs = Date.parse(m.start);
  const endMs = Date.parse(m.end);
  if (Number.isNaN(startMs)) {
    return { minutesUntil: m.minutesUntil, inProgress: m.inProgress };
  }
  const minutesUntil = Math.round((startMs - nowMs) / 60_000);
  const inProgress =
    !Number.isNaN(endMs) && startMs <= nowMs && endMs > nowMs;
  return { minutesUntil, inProgress };
}

function formatCountdown(m: GoodMorningPreBriefMeeting, nowMs: number): string {
  const { minutesUntil, inProgress } = liveStatus(m, nowMs);
  if (inProgress) return "In progress";
  if (minutesUntil === null) return "";
  if (minutesUntil < 0) {
    const ago = -minutesUntil;
    if (ago < 60) return `Ended ${ago}m ago`;
    const h = Math.floor(ago / 60);
    const r = ago - h * 60;
    return `Ended ${h}h${r > 0 ? ` ${r}m` : ""} ago`;
  }
  if (minutesUntil < 60) return `in ${minutesUntil}m`;
  const h = Math.floor(minutesUntil / 60);
  const r = minutesUntil - h * 60;
  return `in ${h}h${r > 0 ? ` ${r}m` : ""}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface GoodMorningWidgetProps {
  spec: GoodMorningWidgetSpec;
}

export function GoodMorningWidget({ spec }: GoodMorningWidgetProps) {
  /* Pre-brief selector state. Defaults to the server-picked meeting
   * (in-progress > soonest > most-recently-ended). */
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(
    spec.preBrief?.defaultMeetingId ?? null,
  );
  /* Tick every 30s so the countdown stays accurate without a refetch. */
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!spec.preBrief || spec.preBrief.meetings.length === 0) return;
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [spec.preBrief]);

  const selectedMeeting = useMemo(() => {
    if (!spec.preBrief || !selectedMeetingId) return null;
    return spec.preBrief.meetings.find((m) => m.id === selectedMeetingId) ?? null;
  }, [spec.preBrief, selectedMeetingId]);

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
      className="mt-2 rounded-md p-3 min-w-0 max-w-full overflow-hidden"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      {/* Header: full-width greeting on mobile; on sm+ the
          "Open dashboard" link sits in the top-right gutter. The
          flex-wrap variant prevents the greeting from getting cropped
          to "Good mor..." on narrow viewports. */}
      <div className="mb-3">
        <div className="flex items-start justify-between gap-3">
          <div
            className="text-sm font-semibold break-words"
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            {spec.greeting}
          </div>
          <a
            href="/"
            onClick={() => trackInteraction("open_dashboard")}
            className="text-xs whitespace-nowrap shrink-0 pt-0.5"
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            Open dashboard →
          </a>
        </div>
        <div
          className="text-xs mt-1"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
        >
          {spec.summary}
        </div>
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

      {/* Meeting Pre-Brief — same source as dashboard panel */}
      {spec.preBrief && (
        <div
          data-testid="good-morning-prebrief"
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
            Meeting Pre-Brief
          </div>
          {spec.preBrief.meetings.length === 0 ? (
            <div
              data-testid="good-morning-prebrief-empty"
              className="text-xs"
              style={{ color: "var(--wp-text-muted, #6b7280)" }}
            >
              No meetings in the next {spec.preBrief.lookaheadHours} hours.
            </div>
          ) : (
            <>
              {/* Stacked picker: label on its own line, select takes
                  the full row. Side-by-side ate too much horizontal
                  space on mobile. Only show the picker when there's
                  more than one meeting to pick — a single-meeting
                  panel doesn't need a chooser. */}
              {spec.preBrief.meetings.length > 1 && (
                <div className="mb-2">
                  <label
                    htmlFor="good-morning-prebrief-picker"
                    className="block text-[11px] mb-1"
                    style={{ color: "var(--wp-text-muted, #6b7280)" }}
                  >
                    Pick a meeting
                  </label>
                  <select
                    id="good-morning-prebrief-picker"
                    data-testid="good-morning-prebrief-picker"
                    value={selectedMeetingId ?? ""}
                    onChange={(e) => {
                      setSelectedMeetingId(e.target.value);
                      trackInteraction("select_prebrief_meeting", {
                        meeting_id: e.target.value,
                      });
                    }}
                    className="text-xs rounded border px-2 py-1.5 w-full"
                    style={{
                      background: "var(--wp-dark-surface2, #1a1a1a)",
                      borderColor: "var(--wp-dark-border, #333)",
                      color: "var(--wp-text, #eee)",
                    }}
                  >
                    {spec.preBrief.meetings.map((m) => (
                      <option key={m.id} value={m.id}>
                        {formatWhen(m.start)} · {m.subject} ({formatCountdown(m, nowMs)})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {selectedMeeting && (
                <div data-testid="good-morning-prebrief-selected" className="text-xs space-y-1.5">
                  <div
                    className="font-semibold break-words"
                    style={{ color: "var(--wp-gold, #eab308)" }}
                  >
                    {selectedMeeting.subject}
                  </div>
                  <div
                    className="flex flex-wrap gap-x-2 gap-y-0.5"
                    style={{ color: "var(--wp-text-muted, #6b7280)" }}
                  >
                    <span className="whitespace-nowrap">
                      {formatCountdown(selectedMeeting, nowMs)}
                    </span>
                    <span className="whitespace-nowrap">
                      · {formatWhen(selectedMeeting.start)}
                    </span>
                    {selectedMeeting.location && (
                      <span className="truncate max-w-full">· {selectedMeeting.location}</span>
                    )}
                    {selectedMeeting.isOnlineMeeting && <span>· Teams</span>}
                  </div>
                  {selectedMeeting.attendees.length > 0 && (
                    <div
                      className="break-words"
                      style={{ color: "var(--wp-text-muted, #6b7280)" }}
                    >
                      <span style={{ color: "var(--wp-text-dim, #aaa)" }}>
                        {selectedMeeting.attendees.length}{" "}
                        {selectedMeeting.attendees.length === 1 ? "attendee" : "attendees"}
                      </span>
                      {" · "}
                      {selectedMeeting.attendees.slice(0, 3).join(", ")}
                      {selectedMeeting.attendees.length > 3
                        ? `, +${selectedMeeting.attendees.length - 3} more`
                        : ""}
                    </div>
                  )}
                  <a
                    href={`/meetings/${encodeURIComponent(selectedMeeting.id)}`}
                    onClick={() =>
                      trackInteraction("open_prebrief_detail", {
                        meeting_id: selectedMeeting.id,
                      })
                    }
                    className="inline-block pt-0.5"
                    style={{ color: "var(--wp-gold, #eab308)" }}
                  >
                    Open full pre-brief →
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      )}

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
