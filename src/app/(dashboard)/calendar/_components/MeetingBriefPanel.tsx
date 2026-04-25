"use client";

/**
 * MeetingBriefPanel — Phase 4 calendar-event integration.
 *
 * Renders the rolling brief composed by /api/meetings/brief for a
 * single calendar event. Empty state when no feed matches; analyzed
 * status surfaces per recent message so the user knows whether
 * Phase 2/3 has caught up.
 *
 * Authenticated client fetch: routed through `fetchWithRefresh`
 * (per CLAUDE.md no-raw-api-fetch guardrail).
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface BriefRecentMessage {
  id: string;
  subject: string;
  received_at: string;
  summary?: string | null;
  analyzed: boolean;
}

interface ActionItem {
  description: string;
  assignee?: string | null;
  due?: string | null;
  source_message_id?: string | null;
}

interface RecurringTopic {
  topic: string;
  mention_count: number;
}

interface BriefFeed {
  id: string;
  slug: string;
  name: string;
}

export interface MeetingBriefView {
  feed: BriefFeed;
  recent_messages: BriefRecentMessage[];
  open_action_items: ActionItem[];
  recurring_topics: RecurringTopic[];
  exception_count: number;
}

function fireAnalytics(event: string, metadata: Record<string, string | number | boolean>): void {
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ event, metadata }),
  }).catch(() => {});
}

export function MeetingBriefPanel({
  eventId,
  eventTitle,
  eventStart,
  attendees,
}: {
  eventId: string;
  eventTitle: string;
  eventStart: string;
  attendees: string[];
}) {
  const [brief, setBrief] = useState<MeetingBriefView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBrief(null);

    const params = new URLSearchParams();
    params.set("title", eventTitle);
    params.set("start", eventStart);
    for (const a of attendees) params.append("attendee", a);

    fetchWithRefresh(`/api/meetings/brief?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setError("You don't have access to meeting insights.");
          setLoading(false);
          return;
        }
        if (!res.ok) {
          setError(`Unable to load brief (${res.status})`);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as { brief: MeetingBriefView | null };
        setBrief(data.brief ?? null);
        setLoading(false);
        fireAnalytics("calendar.meeting_brief_viewed", {
          event_id: eventId,
          matched: data.brief !== null,
          feed_slug: data.brief?.feed.slug ?? "",
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(`Network error: ${(e as Error).message}`);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, eventTitle, eventStart, attendees]);

  if (loading) {
    return (
      <div
        data-testid={`meeting-brief-${eventId}-loading`}
        style={{ marginTop: 8, fontSize: "0.85rem", color: "var(--wp-text-dim)" }}
      >
        Loading brief…
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid={`meeting-brief-${eventId}-error`}
        style={{ marginTop: 8, fontSize: "0.85rem", color: "var(--wp-warning)" }}
      >
        {error}
      </div>
    );
  }

  if (!brief) {
    return (
      <div
        data-testid={`meeting-brief-${eventId}-empty`}
        style={{
          marginTop: 8,
          fontSize: "0.85rem",
          color: "var(--wp-text-dim)",
        }}
      >
        No meeting-insights feed matches this event title.{" "}
        <Link
          href="/meetings/feeds"
          style={{ color: "var(--wp-gold)", textDecoration: "underline" }}
        >
          Configure feeds →
        </Link>
      </div>
    );
  }

  return (
    <div
      data-testid={`meeting-brief-${eventId}`}
      style={{
        marginTop: 10,
        padding: "0.75rem 1rem",
        background: "var(--wp-dark-surface2)",
        border: "1px solid var(--wp-dark-border)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: "0.85rem", color: "var(--wp-text)" }}>
          <span style={{ color: "var(--wp-text-dim)" }}>Brief from feed:</span>{" "}
          <Link
            href={`/meetings/feeds/${brief.feed.slug}`}
            data-testid={`meeting-brief-${eventId}-feed-link`}
            style={{ color: "var(--wp-gold)", textDecoration: "none" }}
          >
            {brief.feed.name}
          </Link>
        </div>
      </div>

      {brief.exception_count > 0 && (
        <div
          data-testid={`meeting-brief-${eventId}-exceptions`}
          style={{
            marginTop: 8,
            padding: "0.4rem 0.6rem",
            background: "rgba(234, 179, 8, 0.15)",
            color: "var(--wp-warning)",
            borderRadius: 6,
            fontSize: "0.8rem",
          }}
        >
          {brief.exception_count} open exception
          {brief.exception_count === 1 ? "" : "s"} on this feed.
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <div
          style={{
            fontSize: "0.75rem",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--wp-text-muted)",
            marginBottom: 4,
          }}
        >
          Recent meetings
        </div>
        {brief.recent_messages.length === 0 ? (
          <p style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", margin: 0 }}>
            No prior meetings ingested yet.
          </p>
        ) : (
          <ul
            data-testid={`meeting-brief-${eventId}-recent`}
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 4,
            }}
          >
            {brief.recent_messages.map((m) => (
              <li
                key={m.id}
                style={{ fontSize: "0.85rem", color: "var(--wp-text)" }}
              >
                <Link
                  href={`/meetings/feeds/${brief.feed.slug}/messages/${m.id}`}
                  style={{ color: "var(--wp-text)", textDecoration: "none" }}
                >
                  <span style={{ color: "var(--wp-text-dim)", marginRight: 6 }}>
                    {new Date(m.received_at).toLocaleDateString()}
                  </span>
                  {m.subject}
                </Link>
                {m.summary && (
                  <div
                    style={{
                      fontSize: "0.78rem",
                      color: "var(--wp-text-dim)",
                      marginLeft: 12,
                    }}
                  >
                    {m.summary}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {brief.open_action_items.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              fontSize: "0.75rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--wp-text-muted)",
              marginBottom: 4,
            }}
          >
            Open action items
          </div>
          <ul
            data-testid={`meeting-brief-${eventId}-actions`}
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 4,
            }}
          >
            {brief.open_action_items.map((a, i) => {
              const linkHref = a.source_message_id
                ? `/meetings/feeds/${brief.feed.slug}/messages/${a.source_message_id}`
                : null;
              const inner = (
                <span style={{ fontSize: "0.85rem", color: "var(--wp-text)" }}>
                  <span style={{ marginRight: 6, color: "var(--wp-text-dim)" }}>☐</span>
                  {a.description}
                  {a.assignee && (
                    <span style={{ color: "var(--wp-text-muted)", marginLeft: 6 }}>
                      ({a.assignee})
                    </span>
                  )}
                </span>
              );
              return (
                <li key={`${a.description}-${i}`}>
                  {linkHref ? (
                    <Link
                      href={linkHref}
                      style={{ textDecoration: "none", color: "var(--wp-text)" }}
                    >
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {brief.recurring_topics.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              fontSize: "0.75rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--wp-text-muted)",
              marginBottom: 4,
            }}
          >
            Recurring topics
          </div>
          <div
            data-testid={`meeting-brief-${eventId}-topics`}
            style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
          >
            {brief.recurring_topics.map((t) => (
              <span
                key={t.topic}
                style={{
                  background: "var(--wp-dark-surface)",
                  border: "1px solid var(--wp-dark-border)",
                  borderRadius: 999,
                  padding: "0.15rem 0.55rem",
                  fontSize: "0.78rem",
                  color: "var(--wp-text)",
                }}
              >
                {t.topic} <span style={{ color: "var(--wp-text-dim)" }}>×{t.mention_count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
