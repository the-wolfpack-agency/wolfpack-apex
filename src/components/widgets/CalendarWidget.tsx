/**
 * CalendarWidget — mini month grid rendered inline in the chat.
 *
 * UI:
 *   - Month + year header
 *   - 7-column day grid for the displayed month
 *   - Dot indicator on days that have events
 *   - Click a day → expand a list of that day's meetings below the grid
 *   - Each meeting links to its Instinct detail page (in-app) with a
 *     secondary "Open in Outlook" link when webLink is available
 *
 * Pure render component: no fetching, no mutation. Data comes from the
 * CalendarWidgetSpec the tool produced server-side.
 */

"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import type {
  CalendarWidgetSpec,
  CalendarWidgetEvent,
} from "@/lib/assistant/widgets/types";
import { fetchWithRefresh } from "@/lib/client-auth";

const DAY_NAMES = ["S", "M", "T", "W", "T", "F", "S"];

interface DayCell {
  /** YYYY-MM-DD for the day in the displayed month, or null for
   *  padding cells at the start/end of the grid. */
  date: string | null;
  dayOfMonth: number | null;
  events: CalendarWidgetEvent[];
}

function buildMonthGrid(spec: CalendarWidgetSpec): DayCell[] {
  const monthStart = new Date(spec.month);
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  /* Day-of-week of the 1st (0=Sun, 6=Sat). */
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();

  /* Group events by YYYY-MM-DD using LOCAL time so meetings at 9pm
   * don't get counted on the next day. */
  const eventsByDay = new Map<string, CalendarWidgetEvent[]>();
  for (const ev of spec.events) {
    const d = new Date(ev.start);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const bucket = eventsByDay.get(key) ?? [];
    bucket.push(ev);
    eventsByDay.set(key, bucket);
  }

  const cells: DayCell[] = [];
  /* Padding before day 1. */
  for (let i = 0; i < firstDow; i++) {
    cells.push({ date: null, dayOfMonth: null, events: [] });
  }
  /* Days of the month. */
  for (let d = 1; d <= lastDay; d++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({
      date: key,
      dayOfMonth: d,
      events: (eventsByDay.get(key) ?? []).sort(
        (a, b) => Date.parse(a.start) - Date.parse(b.start),
      ),
    });
  }
  /* Pad to a multiple of 7 so the grid is rectangular. */
  while (cells.length % 7 !== 0) {
    cells.push({ date: null, dayOfMonth: null, events: [] });
  }
  return cells;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return minutes === 0
    ? `${hours}${ampm}`
    : `${hours}:${String(minutes).padStart(2, "0")}${ampm}`;
}

function monthLabel(monthIso: string): string {
  const d = new Date(monthIso);
  /* UTC so the label tracks the grid (which is built from UTC bounds). */
  return d.toLocaleString("default", { month: "long", year: "numeric", timeZone: "UTC" });
}

function isToday(dateStr: string): boolean {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return dateStr === todayKey;
}

export interface CalendarWidgetProps {
  spec: CalendarWidgetSpec;
}

export function CalendarWidget({ spec }: CalendarWidgetProps) {
  const cells = useMemo(() => buildMonthGrid(spec), [spec]);
  /* Default: expand today if it falls in this month and has events. */
  const initialDay = useMemo(() => {
    const todayCell = cells.find((c) => c.date && isToday(c.date) && c.events.length > 0);
    return todayCell?.date ?? null;
  }, [cells]);
  const [selectedDay, setSelectedDay] = useState<string | null>(initialDay);

  /* Fire a one-shot analytics event when the widget mounts so the
   * learning loop sees the funnel: offered (server-side) -> rendered
   * (this hook). */
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: { widget_kind: "calendar", event_count: spec.events.length, month: spec.month },
      }),
    }).catch(() => undefined);
  }, [spec.month, spec.events.length]);

  const selectedEvents = selectedDay
    ? cells.find((c) => c.date === selectedDay)?.events ?? []
    : [];

  function trackInteraction(action: string) {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: { widget_kind: "calendar", action },
      }),
    }).catch(() => undefined);
  }

  return (
    <div
      data-testid="calendar-widget"
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
        <div className="text-sm font-semibold">
          {spec.title ? `${spec.title}: ` : ""}{monthLabel(spec.month)}
        </div>
        <Link
          href="/calendar"
          onClick={() => trackInteraction("open_calendar_page")}
          className="text-xs"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          Open full calendar
        </Link>
      </div>

      <div className="grid grid-cols-7 gap-0.5 mb-2">
        {DAY_NAMES.map((d, i) => (
          <div
            key={i}
            className="text-center text-xs"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
          >
            {d}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c.date) {
            return <div key={i} className="aspect-square" />;
          }
          const hasEvents = c.events.length > 0;
          const isSelected = c.date === selectedDay;
          const today = isToday(c.date);
          return (
            <button
              key={i}
              data-testid={`calendar-day-${c.date}`}
              onClick={() => {
                setSelectedDay(isSelected ? null : c.date);
                if (!isSelected) trackInteraction("expand_day");
              }}
              className="aspect-square flex flex-col items-center justify-center text-xs rounded transition-colors"
              style={{
                background: isSelected
                  ? "rgba(234,179,8,0.20)"
                  : today
                  ? "rgba(234,179,8,0.08)"
                  : "transparent",
                color: today
                  ? "var(--wp-gold, #eab308)"
                  : "var(--wp-text-dim, #aaa)",
                border: isSelected
                  ? "1px solid rgba(234,179,8,0.5)"
                  : "1px solid transparent",
                cursor: hasEvents ? "pointer" : "default",
              }}
            >
              <span>{c.dayOfMonth}</span>
              {hasEvents && (
                <span
                  data-testid={`calendar-dot-${c.date}`}
                  className="block w-1 h-1 rounded-full mt-0.5"
                  style={{ background: "var(--wp-gold, #eab308)" }}
                />
              )}
            </button>
          );
        })}
      </div>

      {selectedDay && (
        <div
          data-testid={`calendar-day-events-${selectedDay}`}
          className="mt-2 pt-2"
          style={{ borderTop: "1px solid var(--wp-dark-border, #333)" }}
        >
          <div
            className="text-xs font-semibold mb-1"
            style={{ color: "var(--wp-text-dim, #aaa)" }}
          >
            {new Date(selectedDay).toLocaleDateString("default", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
            {selectedEvents.length === 0
              ? " · no meetings"
              : ` · ${selectedEvents.length} meeting${selectedEvents.length === 1 ? "" : "s"}`}
          </div>
          <ul className="space-y-1">
            {selectedEvents.map((ev) => (
              <li
                key={ev.id}
                data-testid={`calendar-event-${ev.id}`}
                className="text-xs rounded px-2 py-1.5"
                style={{
                  background: "var(--wp-dark, #111)",
                  border: "1px solid var(--wp-dark-border, #333)",
                }}
              >
                <div
                  className="font-medium"
                  style={{ color: "var(--wp-text, #eee)" }}
                >
                  {ev.subject}
                </div>
                <div
                  className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-0.5"
                  style={{ color: "var(--wp-text-muted, #6b7280)" }}
                >
                  <span className="whitespace-nowrap">
                    {formatTime(ev.start)}
                    {ev.end ? `–${formatTime(ev.end)}` : ""}
                  </span>
                  {ev.location && <span className="truncate max-w-full">· {ev.location}</span>}
                  {ev.isOnlineMeeting && <span>· Teams</span>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {ev.instinctDetailHref && (
                    <Link
                      href={ev.instinctDetailHref}
                      onClick={() => trackInteraction("open_event_detail")}
                      style={{ color: "var(--wp-gold, #eab308)" }}
                    >
                      Open in Instinct
                    </Link>
                  )}
                  {ev.webLink && (
                    <a
                      href={ev.webLink}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={() => trackInteraction("open_outlook")}
                      style={{ color: "var(--wp-text-muted, #9ca3af)" }}
                    >
                      Open in Outlook
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
