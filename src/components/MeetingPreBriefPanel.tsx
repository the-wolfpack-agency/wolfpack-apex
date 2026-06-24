"use client";

/**
 * MeetingPreBriefPanel — dashboard wrapper around <MeetingPreBrief>.
 *
 * Replaces the old "only shows 15 minutes before a meeting" gate with a
 * full 48-hour window (configurable), a dropdown to switch between
 * meetings, and a "starts in …" / "in progress" indicator so the panel
 * is useful outside the pre-meeting scramble.
 *
 * Flow:
 *   1. GET /api/meetings/upcoming?hours=48   → picks default meeting
 *   2. render <MeetingPreBrief meetingId=...>
 *   3. dropdown lets user pick any meeting in the window
 *
 * Analytics:
 *   meeting.upcoming_fetched           (server side, in the route)
 *   meeting.prebrief_meeting_selected  (client, fires here when dropdown changes)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import MeetingPreBrief from "@/components/MeetingPreBrief";
import { fetchWithRefresh, authHeaders, jsonHeaders } from "@/lib/client-auth";

interface UpcomingMeeting {
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  isOnlineMeeting: boolean;
  minutesUntil: number | null;
  inProgress: boolean;
  isOutOfOffice: boolean;
}

interface UpcomingResponse {
  meetings: UpcomingMeeting[];
  /** Events flagged as out-of-office (PTO, vacation, OOO subject, or
   *  Microsoft Graph showAs="oof"). Rendered as a passive "Out today"
   *  line above the dropdown, not in the dropdown itself. */
  outOfOffice?: UpcomingMeeting[];
}

interface Props {
  /** Override window for tests / admin views. Default 48h. */
  lookaheadHours?: number;
}

function fireAnalytics(
  event: string,
  metadata: Record<string, string | number | boolean>,
): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ event, metadata }),
  }).catch(() => {});
}

/**
 * Recompute minutesUntil + inProgress live from the ISO start/end + the
 * current client clock. The server sets these once when the request is
 * served; if the user leaves the tab open the server value goes stale
 * (a meeting that's "in 20m" at 3:10 PM still renders as "in 1h 11m"
 * an hour later). Computing locally ticks forward correctly without
 * needing to refetch.
 */
function liveStatus(
  m: UpcomingMeeting,
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

/**
 * Pretty-print minutesUntil as "in 3h 12m" / "in 45m" / "in progress" /
 * "ended 12m ago". Takes the live minutesUntil (computed from Date.now())
 * rather than the frozen server value, so the panel ticks forward without
 * a refetch.
 */
function formatCountdown(m: UpcomingMeeting, nowMs: number): string {
  const { minutesUntil, inProgress } = liveStatus(m, nowMs);
  if (inProgress) return "In progress";
  if (minutesUntil === null) return "";
  const mins = minutesUntil;
  if (mins < 0) {
    const ago = -mins;
    if (ago < 60) return `Ended ${ago}m ago`;
    const h = Math.floor(ago / 60);
    const r = ago - h * 60;
    return `Ended ${h}h${r > 0 ? ` ${r}m` : ""} ago`;
  }
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const r = mins - h * 60;
  return `in ${h}h${r > 0 ? ` ${r}m` : ""}`;
}

/**
 * Pull a clean display label off an OOO event subject. The team's
 * convention is "<Name> OOO" or "<Name> - Out of office" so stripping
 * the OOO tokens leaves the person's name. Falls back to the raw
 * subject if stripping yields nothing useful.
 */
/**
 * True when an out-of-office entry overlaps the user's LOCAL today. The OOO list
 * comes from a -30min..+48h window, which includes TOMORROW, so without this an
 * OOO scheduled for tomorrow was being labelled "Out today" (a wrong, embarrassing
 * client-facing error). An entry counts as today when its [start, end) overlaps
 * [local midnight today, local midnight tomorrow); a start-only entry counts when
 * its start falls within today.
 */
export function isOutToday(
  start: string,
  end: string,
  nowMs: number = Date.now(),
): boolean {
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + 24 * 60 * 60 * 1000;
  const s = Date.parse(start);
  const e = Date.parse(end);
  const sOk = !Number.isNaN(s);
  const eOk = !Number.isNaN(e);
  if (sOk && eOk) return e > startOfToday && s < endOfToday;
  if (sOk) return s >= startOfToday && s < endOfToday;
  return false;
}

function ooEntryLabel(subject: string): string {
  if (!subject) return "";
  const stripped = subject
    .replace(
      /\b(out of the office|out of office|out of pocket|on vacation|on leave|out sick|sick day|sick leave|personal day|personal leave|vacation day|off today|off tomorrow|vacationing|vacation|OOTO|OOO|OoO|OOF|PTO)\b/gi,
      "",
    )
    .replace(/[-:,\s]+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : subject;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Default-selection policy mirrors pickDefaultMeeting on the server:
 *   in-progress > soonest upcoming > most-recently-ended.
 * Duplicated instead of imported so the server lib stays server-only.
 */
function pickDefault(meetings: UpcomingMeeting[]): UpcomingMeeting | null {
  if (meetings.length === 0) return null;
  const live = meetings.find((m) => m.inProgress);
  if (live) return live;
  const upcoming = meetings.find(
    (m) => typeof m.minutesUntil === "number" && m.minutesUntil >= 0,
  );
  if (upcoming) return upcoming;
  const past = [...meetings]
    .filter((m) => typeof m.minutesUntil === "number")
    .sort((a, b) => (b.minutesUntil ?? -Infinity) - (a.minutesUntil ?? -Infinity));
  return past[0] ?? meetings[0];
}

export default function MeetingPreBriefPanel({ lookaheadHours = 48 }: Props) {
  const [meetings, setMeetings] = useState<UpcomingMeeting[] | null>(null);
  const [outOfOffice, setOutOfOffice] = useState<UpcomingMeeting[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Tick the client clock every 30s so the countdown label stays live
  // without needing to refetch. 30s is fine for a minute-granularity label.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  /* Only show people whose OOO actually overlaps TODAY. The fetch window is 48h
     (it powers the meeting dropdown), so tomorrow's OOO would otherwise read as
     "Out today". Recomputes with the live clock so it stays right across midnight. */
  const outOfOfficeToday = useMemo(
    () => outOfOffice.filter((m) => isOutToday(m.start, m.end, nowMs)),
    [outOfOffice, nowMs],
  );
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRefresh(
          `/api/meetings/upcoming?hours=${encodeURIComponent(String(lookaheadHours))}`,
          { headers: authHeaders() },
        );
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setError("restricted");
          setLoading(false);
          return;
        }
        if (!res.ok) {
          setError("Unable to load upcoming meetings");
          setLoading(false);
          return;
        }
        const body = (await res.json()) as UpcomingResponse;
        const list = Array.isArray(body.meetings) ? body.meetings : [];
        const ooo = Array.isArray(body.outOfOffice) ? body.outOfOffice : [];
        setMeetings(list);
        setOutOfOffice(ooo);
        const picked = pickDefault(list);
        setSelectedId(picked?.id ?? null);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError("Unable to load upcoming meetings");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lookaheadHours]);

  const selected = useMemo(
    () => (meetings ?? []).find((m) => m.id === selectedId) ?? null,
    [meetings, selectedId],
  );

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      fireAnalytics("meeting.prebrief_meeting_selected", {
        meeting_id: id,
      });
    },
    [],
  );

  // Hide entirely for users without meetings.view capability — matches
  // MorningBriefing's "don't render for unauthorized" pattern.
  if (error === "restricted") return null;

  if (loading) {
    return (
      <div
        data-testid="meeting-prebrief-panel-loading"
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          Loading upcoming meetings…
        </p>
      </div>
    );
  }

  if (error || !meetings) {
    return (
      <div
        data-testid="meeting-prebrief-panel-error"
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--wp-warning)" }}>
          {error ?? "Unable to load upcoming meetings"}
        </p>
      </div>
    );
  }

  if (meetings.length === 0) {
    return (
      <div
        data-testid="meeting-prebrief-panel-empty"
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--wp-gold)" }}>
          Meeting Pre-Brief
        </h2>
        {outOfOfficeToday.length > 0 && (
          <p
            className="text-xs mb-2"
            data-testid="prebrief-out-of-office"
            style={{ color: "var(--wp-text-dim)" }}
          >
            <span style={{ color: "var(--wp-text)" }}>Out today: </span>
            {outOfOfficeToday.map((m) => ooEntryLabel(m.subject)).join(", ")}
          </p>
        )}
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          No meetings in the next {lookaheadHours} hours. Connect your calendar or come
          back when something's on the books.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="meeting-prebrief-panel"
      className="rounded-lg p-5 border space-y-3"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      <div className="flex flex-col gap-3">
        <h2
          className="text-lg font-semibold whitespace-nowrap"
          style={{ color: "var(--wp-gold)" }}
        >
          Meeting Pre-Brief
        </h2>
        {outOfOfficeToday.length > 0 && (
          <p
            className="text-xs"
            data-testid="prebrief-out-of-office"
            style={{ color: "var(--wp-text-dim)" }}
          >
            <span style={{ color: "var(--wp-text)" }}>Out today: </span>
            {outOfOfficeToday.map((m) => ooEntryLabel(m.subject)).join(", ")}
          </p>
        )}
        <div className="flex items-center gap-2 w-full">
          <label
            htmlFor="prebrief-meeting-picker"
            className="text-xs shrink-0"
            style={{ color: "var(--wp-text-dim)" }}
          >
            Meeting
          </label>
          <select
            id="prebrief-meeting-picker"
            data-testid="prebrief-meeting-picker"
            value={selectedId ?? ""}
            onChange={(e) => handleSelect(e.target.value)}
            className="text-sm rounded-md border px-2 py-1 flex-1 min-w-0"
            style={{
              background: "var(--wp-dark-surface2)",
              borderColor: "var(--wp-dark-border)",
              color: "var(--wp-text)",
            }}
          >
            {meetings.map((m) => (
              <option key={m.id} value={m.id}>
                {formatWhen(m.start)} — {m.subject} ({formatCountdown(m, nowMs)})
              </option>
            ))}
          </select>
        </div>
      </div>

      {selected && (
        <div className="text-xs" data-testid="prebrief-countdown" style={{ color: "var(--wp-text-dim)" }}>
          {formatCountdown(selected, nowMs)}
          {selected.location ? ` · ${selected.location}` : ""}
        </div>
      )}

      {selected && <MeetingPreBrief meetingId={selected.id} />}
    </div>
  );
}
