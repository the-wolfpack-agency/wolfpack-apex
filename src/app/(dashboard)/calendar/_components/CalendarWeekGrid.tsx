"use client";

/**
 * CalendarWeekGrid — Outlook/Teams-style week grid that renders the
 * events `/api/calendar/range?view=week` already returns. Plug-and-
 * play: no extra API calls, no new deps. 7 columns (Sun→Sat) × hourly
 * rows from CAL_DAY_START..CAL_DAY_END; events positioned absolutely
 * inside their day column by start/end time. All-day events sit in a
 * dedicated lane above the time grid (Outlook convention).
 *
 * Click an event card → fires onEventClick(eventId). The page wires
 * that to its brief toggle so the existing MeetingBriefPanel in the
 * flat list expands AND scrolls into view, keeping one source of
 * truth for meeting details. Every click emits an insight so the
 * Brain can learn which events users actually inspect from the grid.
 *
 * Read-only for v1. Phase 2 wires Calendars.ReadWrite for create /
 * drag-resize / RSVP through the existing microsoft-calendar lib.
 */

import { useMemo } from "react";
import { emitInsight } from "@/lib/insights/emit";

export interface WeekGridEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  location?: string;
  attendees?: string[];
  webLink?: string | null;
  joinUrl?: string | null;
}

export interface CalendarWeekGridProps {
  events: WeekGridEvent[];
  /** ISO date for any day in the week to render — Sunday-anchored. */
  anchorIso: string;
  /** Inclusive earliest hour to render in the time grid (0-23). */
  dayStartHour?: number;
  /** Exclusive latest hour to render in the time grid (1-24). */
  dayEndHour?: number;
  /** Toggle the brief panel for this event id. */
  onEventClick: (eventId: string) => void;
  /** Step backward / forward by 7 days. */
  onPrevWeek?: () => void;
  onNextWeek?: () => void;
  /** Snap anchor back to today. */
  onToday?: () => void;
  /** Test override for "now" so the today-marker is deterministic. */
  _now?: () => Date;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_DAY_START = 8;
const DEFAULT_DAY_END = 19; // exclusive
const ROW_HEIGHT_PX = 48; // 1 hour
const HEADER_HEIGHT_PX = 56;

function startOfWeekSunday(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - out.getDay());
  return out;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isAllDay(start: Date, end: Date): boolean {
  // Graph all-day events span midnight→midnight in the user's TZ.
  return (
    start.getHours() === 0 &&
    start.getMinutes() === 0 &&
    end.getHours() === 0 &&
    end.getMinutes() === 0 &&
    end.getTime() - start.getTime() >= 23 * 60 * 60 * 1000
  );
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

interface PositionedEvent {
  e: WeekGridEvent;
  start: Date;
  end: Date;
  topPx: number;
  heightPx: number;
}

/**
 * Pure helper exported for unit testing — positions a single event
 * inside a day column. `dayStartHour` / `dayEndHour` clip overflow.
 */
export function positionEventInDay(
  e: WeekGridEvent,
  dayStartHour: number,
  dayEndHour: number,
): { topPx: number; heightPx: number } {
  const start = new Date(e.start);
  const end = new Date(e.end);
  const startMin = Math.max(
    0,
    (start.getHours() - dayStartHour) * 60 + start.getMinutes(),
  );
  const endMin = Math.min(
    (dayEndHour - dayStartHour) * 60,
    (end.getHours() - dayStartHour) * 60 + end.getMinutes(),
  );
  const topPx = (startMin / 60) * ROW_HEIGHT_PX;
  const heightPx = Math.max(18, ((endMin - startMin) / 60) * ROW_HEIGHT_PX);
  return { topPx, heightPx };
}

export default function CalendarWeekGrid(props: CalendarWeekGridProps) {
  const dayStartHour = props.dayStartHour ?? DEFAULT_DAY_START;
  const dayEndHour = props.dayEndHour ?? DEFAULT_DAY_END;
  const now = props._now ? props._now() : new Date();

  const weekStart = useMemo(
    () => startOfWeekSunday(new Date(props.anchorIso)),
    [props.anchorIso],
  );
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(weekStart.getDate() + i);
        return d;
      }),
    [weekStart],
  );

  const hours = useMemo(
    () =>
      Array.from(
        { length: dayEndHour - dayStartHour },
        (_, i) => dayStartHour + i,
      ),
    [dayStartHour, dayEndHour],
  );

  // Bucket events per day index. All-day rows sit above the time
  // grid (Outlook convention) so a client meeting doesn't visually
  // collide with an all-hands.
  const buckets = useMemo(() => {
    const allDay: WeekGridEvent[][] = [[], [], [], [], [], [], []];
    const timed: PositionedEvent[][] = [[], [], [], [], [], [], []];
    for (const e of props.events) {
      const start = new Date(e.start);
      const end = new Date(e.end);
      const dayIdx = days.findIndex((d) => isSameLocalDay(d, start));
      if (dayIdx === -1) continue;
      if (isAllDay(start, end)) {
        allDay[dayIdx].push(e);
        continue;
      }
      const { topPx, heightPx } = positionEventInDay(e, dayStartHour, dayEndHour);
      timed[dayIdx].push({ e, start, end, topPx, heightPx });
    }
    return { allDay, timed };
  }, [props.events, days, dayStartHour, dayEndHour]);

  const handleEventClick = (id: string, when: "all_day" | "timed") => {
    emitInsight({
      actor: "self",
      role: "user",
      surface: "calendar",
      action: "grid_event_clicked",
      tier: "personal",
      payload: { event_id: id, slot: when },
    });
    props.onEventClick(id);
  };

  const todayDayIdx = days.findIndex((d) => isSameLocalDay(d, now));
  const nowMinutes =
    (now.getHours() - dayStartHour) * 60 + now.getMinutes();
  const showNowLine =
    todayDayIdx >= 0 && nowMinutes >= 0 && nowMinutes <= (dayEndHour - dayStartHour) * 60;
  const nowTopPx = (nowMinutes / 60) * ROW_HEIGHT_PX;

  return (
    <section
      data-testid="calendar-week-grid"
      data-anchor={weekStart.toISOString().slice(0, 10)}
      className="rounded-lg border"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
        overflow: "hidden",
      }}
    >
      <header
        className="flex items-center justify-between gap-2 p-3 border-b"
        style={{ borderColor: "var(--wp-dark-border)" }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="calendar-week-prev"
            onClick={() => {
              emitInsight({
                actor: "self",
                role: "user",
                surface: "calendar",
                action: "grid_navigated",
                tier: "personal",
                payload: { direction: "prev" },
              });
              props.onPrevWeek?.();
            }}
            className="px-2 py-1 rounded text-xs"
            style={{ border: "1px solid var(--wp-dark-border)", color: "var(--wp-text-dim)" }}
          >
            ‹ Prev
          </button>
          <button
            type="button"
            data-testid="calendar-week-today"
            onClick={() => {
              emitInsight({
                actor: "self",
                role: "user",
                surface: "calendar",
                action: "grid_navigated",
                tier: "personal",
                payload: { direction: "today" },
              });
              props.onToday?.();
            }}
            className="px-2 py-1 rounded text-xs font-semibold"
            style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
          >
            Today
          </button>
          <button
            type="button"
            data-testid="calendar-week-next"
            onClick={() => {
              emitInsight({
                actor: "self",
                role: "user",
                surface: "calendar",
                action: "grid_navigated",
                tier: "personal",
                payload: { direction: "next" },
              });
              props.onNextWeek?.();
            }}
            className="px-2 py-1 rounded text-xs"
            style={{ border: "1px solid var(--wp-dark-border)", color: "var(--wp-text-dim)" }}
          >
            Next ›
          </button>
        </div>
        <div className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          {weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} —{" "}
          {days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
        </div>
      </header>

      {/* Day-of-week header row */}
      <div
        className="grid"
        style={{
          gridTemplateColumns: `60px repeat(7, 1fr)`,
          borderBottom: "1px solid var(--wp-dark-border)",
        }}
      >
        <div /> {/* gutter */}
        {days.map((d, i) => {
          const isToday = isSameLocalDay(d, now);
          return (
            <div
              key={i}
              data-testid={`calendar-week-day-header-${i}`}
              data-iso={d.toISOString().slice(0, 10)}
              className="text-center py-2"
              style={{
                color: isToday ? "var(--wp-gold)" : "var(--wp-text-dim)",
                borderLeft: "1px solid var(--wp-dark-border)",
                fontSize: 12,
                fontWeight: isToday ? 700 : 500,
              }}
            >
              <div>{DAY_LABELS[i]}</div>
              <div style={{ fontSize: 16 }}>{d.getDate()}</div>
            </div>
          );
        })}
      </div>

      {/* All-day lane */}
      {buckets.allDay.some((b) => b.length > 0) ? (
        <div
          data-testid="calendar-week-allday-lane"
          className="grid"
          style={{
            gridTemplateColumns: `60px repeat(7, 1fr)`,
            borderBottom: "1px solid var(--wp-dark-border)",
            background: "var(--wp-dark-surface2)",
          }}
        >
          <div
            className="text-xs px-2 py-2"
            style={{ color: "var(--wp-text-muted)" }}
          >
            All-day
          </div>
          {buckets.allDay.map((dayEvents, i) => (
            <div
              key={i}
              data-testid={`calendar-week-allday-col-${i}`}
              className="py-1 px-1 flex flex-col gap-1"
              style={{ borderLeft: "1px solid var(--wp-dark-border)" }}
            >
              {dayEvents.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  data-testid={`calendar-week-event-${e.id}`}
                  onClick={() => handleEventClick(e.id, "all_day")}
                  className="text-left rounded px-2 py-1 text-xs truncate"
                  style={{
                    background: "rgba(234,179,8,0.18)",
                    color: "var(--wp-text)",
                    border: "1px solid var(--wp-gold)",
                    cursor: "pointer",
                  }}
                  title={e.subject}
                >
                  {e.subject || "(no subject)"}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* Time grid */}
      <div
        data-testid="calendar-week-time-grid"
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: `60px repeat(7, 1fr)`,
        }}
      >
        {/* Hour gutter */}
        <div style={{ borderRight: "1px solid var(--wp-dark-border)" }}>
          {hours.map((h) => (
            <div
              key={h}
              data-testid={`calendar-week-hour-${h}`}
              style={{
                height: ROW_HEIGHT_PX,
                fontSize: 11,
                color: "var(--wp-text-muted)",
                textAlign: "right",
                paddingRight: 6,
                paddingTop: 2,
              }}
            >
              {h % 12 === 0 ? 12 : h % 12}
              {h < 12 ? "a" : "p"}
            </div>
          ))}
        </div>

        {/* Day columns */}
        {days.map((d, i) => {
          const isToday = isSameLocalDay(d, now);
          return (
            <div
              key={i}
              data-testid={`calendar-week-col-${i}`}
              style={{
                position: "relative",
                borderLeft: "1px solid var(--wp-dark-border)",
                background: isToday ? "rgba(234,179,8,0.04)" : "transparent",
              }}
            >
              {/* Hour rules */}
              {hours.map((h) => (
                <div
                  key={h}
                  style={{
                    height: ROW_HEIGHT_PX,
                    borderTop: "1px solid var(--wp-dark-border)",
                  }}
                />
              ))}
              {/* Now line — only on today's column */}
              {isToday && showNowLine ? (
                <div
                  data-testid="calendar-week-now-line"
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: nowTopPx,
                    height: 2,
                    background: "var(--wp-gold)",
                    pointerEvents: "none",
                  }}
                />
              ) : null}
              {/* Timed events */}
              {buckets.timed[i].map((p) => (
                <button
                  key={p.e.id}
                  type="button"
                  data-testid={`calendar-week-event-${p.e.id}`}
                  onClick={() => handleEventClick(p.e.id, "timed")}
                  className="text-left"
                  style={{
                    position: "absolute",
                    left: 4,
                    right: 4,
                    top: p.topPx,
                    height: p.heightPx,
                    background: "rgba(234,179,8,0.18)",
                    border: "1px solid var(--wp-gold)",
                    color: "var(--wp-text)",
                    borderRadius: 4,
                    padding: "4px 6px",
                    overflow: "hidden",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                  title={`${p.e.subject} · ${fmtTime(p.start)}-${fmtTime(p.end)}`}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.e.subject || "(no subject)"}
                  </div>
                  <div
                    style={{
                      color: "var(--wp-text-dim)",
                      fontSize: 11,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {fmtTime(p.start)}
                    {p.e.location ? ` · ${p.e.location}` : ""}
                  </div>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <footer
        className="px-3 py-2 text-xs"
        style={{
          color: "var(--wp-text-muted)",
          borderTop: "1px solid var(--wp-dark-border)",
          background: "var(--wp-dark-surface2)",
        }}
      >
        Tap any event to open the meeting brief below.
      </footer>

      {/* HEADER_HEIGHT_PX is referenced by tests + future drag-resize. */}
      <span style={{ display: "none" }} data-row-height={ROW_HEIGHT_PX} data-header-height={HEADER_HEIGHT_PX} />
    </section>
  );
}
