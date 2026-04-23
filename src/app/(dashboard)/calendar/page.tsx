"use client";

/**
 * /calendar — Week / Month / Year view with historical insights and
 * deterministic rule-based suggestions. Every interaction fires an
 * analytics event + feeds the Brain via /api/calendar/range.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  authHeaders,
  fetchWithRefresh,
  jsonHeaders,
} from "@/lib/client-auth";

type View = "week" | "month" | "year";

interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  /** Outlook web deeplink — subject click-through target. */
  webLink?: string | null;
  /** Teams join URL — "Join" button target when present. */
  joinUrl?: string | null;
}

interface HistoricalInsights {
  totalMeetingHours: number;
  meetingCount: number;
  soloBlockCount: number;
  averageDurationMinutes: number | null;
  backToBackPct: number;
  topAttendees: Array<{ display: string; count: number }>;
  weeklySeries: Array<{ weekStartIso: string; hours: number; count: number }>;
  dayOfWeekDistribution: number[];
}

interface Suggestion {
  id: string;
  severity: "info" | "watch" | "act";
  headline: string;
  detail: string;
}

interface RangeResponse {
  view: View;
  range: { startIso: string; endIso: string };
  events: CalendarEvent[];
  insights: HistoricalInsights;
  suggestions: Suggestion[];
}

function fireAnalytics(event: string, metadata: Record<string, string | number | boolean>): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ event, metadata }),
  }).catch(() => {});
}

const SEVERITY_STYLE: Record<Suggestion["severity"], { bg: string; color: string; label: string }> = {
  act: { bg: "rgba(239, 68, 68, 0.15)", color: "var(--wp-error)", label: "Act" },
  watch: { bg: "rgba(234, 179, 8, 0.15)", color: "var(--wp-warning)", label: "Watch" },
  info: { bg: "rgba(107, 114, 128, 0.15)", color: "var(--wp-text-dim)", label: "Info" },
};

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [data, setData] = useState<RangeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const viewedSuggestionIds = useMemo(() => new Set<string>(), []);

  const load = useCallback(async (nextView: View) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/calendar/range?view=${encodeURIComponent(nextView)}`,
        { headers: authHeaders() },
      );
      if (res.status === 401 || res.status === 403) {
        setError("restricted");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError("Unable to load calendar");
        setLoading(false);
        return;
      }
      const body = (await res.json()) as RangeResponse;
      setData(body);
      setLoading(false);
      for (const s of body.suggestions) {
        if (viewedSuggestionIds.has(s.id)) continue;
        viewedSuggestionIds.add(s.id);
        fireAnalytics("calendar.suggestion_viewed", {
          suggestion_id: s.id,
          severity: s.severity,
          view: nextView,
        });
      }
    } catch {
      setError("Unable to load calendar");
      setLoading(false);
    }
  }, [viewedSuggestionIds]);

  useEffect(() => {
    fireAnalytics("calendar.page_viewed", {});
    load("week");
  }, [load]);

  const switchView = useCallback(
    (next: View) => {
      if (next === view) return;
      setView(next);
      fireAnalytics("calendar.view_changed", { from: view, to: next });
      load(next);
    },
    [view, load],
  );

  if (error === "restricted") return null;

  return (
    <div className="max-w-6xl mx-auto space-y-6" data-testid="calendar-page">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Calendar
        </h1>
        <div className="flex items-center gap-1 rounded-lg border p-1" style={{ borderColor: "var(--wp-dark-border)", background: "var(--wp-dark-surface2)" }}>
          {(["week", "month", "year"] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`calendar-view-${v}`}
              onClick={() => switchView(v)}
              className="px-3 py-1 rounded text-sm font-medium transition-colors"
              style={{
                background: view === v ? "var(--wp-gold)" : "transparent",
                color: view === v ? "var(--wp-dark)" : "var(--wp-text-dim)",
              }}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <p data-testid="calendar-loading" className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          Loading {view} view…
        </p>
      )}

      {error && !loading && (
        <p data-testid="calendar-error" className="text-sm" style={{ color: "var(--wp-warning)" }}>
          {error}
        </p>
      )}

      {data && !loading && (
        <>
          <div
            className="rounded-lg p-4 border"
            style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
          >
            <p className="text-xs uppercase tracking-wide" style={{ color: "var(--wp-text-muted)" }}>
              {new Date(data.range.startIso).toLocaleDateString()} →{" "}
              {new Date(data.range.endIso).toLocaleDateString()}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
              <Stat label="Meetings" value={String(data.insights.meetingCount)} />
              <Stat label="Hours total" value={`${data.insights.totalMeetingHours}h`} />
              <Stat
                label="Avg duration"
                value={
                  data.insights.averageDurationMinutes !== null
                    ? `${data.insights.averageDurationMinutes}m`
                    : "—"
                }
              />
              <Stat label="Back-to-back" value={`${data.insights.backToBackPct}%`} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Suggestions" testid="calendar-suggestions">
              {data.suggestions.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
                  No suggestions for this range.
                </p>
              ) : (
                <div className="space-y-2">
                  {data.suggestions.map((s) => {
                    const sev = SEVERITY_STYLE[s.severity];
                    return (
                      <div
                        key={s.id}
                        data-testid={`suggestion-${s.id}`}
                        className="rounded-lg p-3 border"
                        style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
                      >
                        <span
                          className="text-xs font-bold px-2 py-0.5 rounded-full"
                          style={{ background: sev.bg, color: sev.color }}
                        >
                          {sev.label}
                        </span>
                        <p className="text-sm font-medium mt-2" style={{ color: "var(--wp-text)" }}>
                          {s.headline}
                        </p>
                        <p className="text-xs mt-1" style={{ color: "var(--wp-text-dim)" }}>
                          {s.detail}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            <Section title="Top contacts" testid="calendar-top-contacts">
              {data.insights.topAttendees.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
                  No recurring contacts in this range.
                </p>
              ) : (
                <ul className="space-y-1">
                  {data.insights.topAttendees.map((a) => (
                    <li key={a.display} className="flex items-center justify-between text-sm">
                      <span style={{ color: "var(--wp-text)" }}>{a.display}</span>
                      <span style={{ color: "var(--wp-text-dim)" }}>{a.count} meetings</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <Section title="Meeting-hours trend (weekly)" testid="calendar-weekly-series">
            {data.insights.weeklySeries.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
                Nothing to chart yet.
              </p>
            ) : (
              <div className="flex items-end gap-1 h-24" data-testid="weekly-bars">
                {data.insights.weeklySeries.map((w) => {
                  const max = Math.max(...data.insights.weeklySeries.map((x) => x.hours), 1);
                  const pct = Math.max(4, Math.round((w.hours / max) * 100));
                  return (
                    <div
                      key={w.weekStartIso}
                      title={`Week of ${new Date(w.weekStartIso).toLocaleDateString()}: ${w.hours}h · ${w.count} meetings`}
                      style={{
                        flex: 1,
                        height: `${pct}%`,
                        background: "var(--wp-gold)",
                        borderRadius: 2,
                        opacity: 0.7,
                      }}
                    />
                  );
                })}
              </div>
            )}
          </Section>

          <Section title="Day-of-week distribution" testid="calendar-dow">
            <div className="grid grid-cols-7 gap-1 text-center">
              {data.insights.dayOfWeekDistribution.map((n, i) => {
                const max = Math.max(...data.insights.dayOfWeekDistribution, 1);
                const pct = Math.round((n / max) * 100);
                return (
                  <div key={i} className="flex flex-col items-center gap-1">
                    <div
                      className="w-full rounded"
                      style={{ height: `${Math.max(4, pct)}%`, background: "var(--wp-gold)", opacity: 0.7, minHeight: 4 }}
                    />
                    <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                      {DOW_LABELS[i]}
                    </div>
                    <div className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                      {n}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title={`Events (${data.events.length})`} testid="calendar-events">
            {data.events.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
                No events in this range.
              </p>
            ) : (
              <ul className="space-y-2">
                {data.events.slice(0, 50).map((e) => {
                  const hasWeb = !!e.webLink;
                  const hasJoin = !!e.joinUrl;
                  const onOpenExternal = (target: "web" | "join") => {
                    fireAnalytics("calendar.meeting_opened_external", {
                      event_id: e.id,
                      target,
                    });
                  };
                  return (
                    <li
                      key={e.id}
                      data-testid={`calendar-event-${e.id}`}
                      className="flex justify-between gap-3 border-b pb-2"
                      style={{ borderColor: "var(--wp-dark-border)" }}
                    >
                      <div className="min-w-0">
                        {hasWeb ? (
                          <a
                            href={e.webLink as string}
                            target="_blank"
                            rel="noreferrer noopener"
                            data-testid={`calendar-event-weblink-${e.id}`}
                            onClick={() => onOpenExternal("web")}
                            className="text-sm font-medium truncate block hover:underline"
                            style={{ color: "var(--wp-gold)" }}
                          >
                            {e.subject}
                          </a>
                        ) : (
                          <p className="text-sm font-medium truncate" style={{ color: "var(--wp-text)" }}>
                            {e.subject}
                          </p>
                        )}
                        <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                          {new Date(e.start).toLocaleString()}
                          {e.location ? ` · ${e.location}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {hasJoin && (
                          <a
                            href={e.joinUrl as string}
                            target="_blank"
                            rel="noreferrer noopener"
                            data-testid={`calendar-event-joinurl-${e.id}`}
                            onClick={() => onOpenExternal("join")}
                            className="text-xs font-semibold px-2 py-1 rounded"
                            style={{
                              background: "var(--wp-gold)",
                              color: "var(--wp-dark)",
                            }}
                          >
                            Join
                          </a>
                        )}
                        <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                          {e.attendees.length} attendee{e.attendees.length === 1 ? "" : "s"}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-lg p-3 border"
      style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
    >
      <p className="text-xl font-bold" style={{ color: "var(--wp-gold)" }}>
        {value}
      </p>
      <p className="text-xs mt-0.5" style={{ color: "var(--wp-text-dim)" }}>
        {label}
      </p>
    </div>
  );
}

function Section({ title, testid, children }: { title: string; testid: string; children: React.ReactNode }) {
  return (
    <section
      data-testid={testid}
      className="rounded-lg p-4 border space-y-2"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      <h2 className="text-sm font-semibold" style={{ color: "var(--wp-gold)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}
