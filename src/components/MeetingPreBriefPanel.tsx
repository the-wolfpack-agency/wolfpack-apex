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
}

interface UpcomingResponse {
  meetings: UpcomingMeeting[];
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
 * Pretty-print minutesUntil as "in 3h 12m" / "in 45m" / "in progress" /
 * "ended 12m ago". Same helper on the server would be fine, but keeping
 * it here keeps the API response shape minimal.
 */
function formatCountdown(m: UpcomingMeeting): string {
  if (m.inProgress) return "In progress";
  if (m.minutesUntil === null) return "";
  const mins = m.minutesUntil;
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
        setMeetings(list);
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <h2 className="text-lg font-semibold" style={{ color: "var(--wp-gold)" }}>
          Meeting Pre-Brief
        </h2>
        <div className="flex items-center gap-2">
          <label
            htmlFor="prebrief-meeting-picker"
            className="text-xs"
            style={{ color: "var(--wp-text-dim)" }}
          >
            Meeting
          </label>
          <select
            id="prebrief-meeting-picker"
            data-testid="prebrief-meeting-picker"
            value={selectedId ?? ""}
            onChange={(e) => handleSelect(e.target.value)}
            className="text-sm rounded-md border px-2 py-1"
            style={{
              background: "var(--wp-dark-surface2)",
              borderColor: "var(--wp-dark-border)",
              color: "var(--wp-text)",
            }}
          >
            {meetings.map((m) => (
              <option key={m.id} value={m.id}>
                {formatWhen(m.start)} — {m.subject} ({formatCountdown(m)})
              </option>
            ))}
          </select>
        </div>
      </div>

      {selected && (
        <div className="text-xs" data-testid="prebrief-countdown" style={{ color: "var(--wp-text-dim)" }}>
          {formatCountdown(selected)}
          {selected.location ? ` · ${selected.location}` : ""}
        </div>
      )}

      {selected && <MeetingPreBrief meetingId={selected.id} />}
    </div>
  );
}
