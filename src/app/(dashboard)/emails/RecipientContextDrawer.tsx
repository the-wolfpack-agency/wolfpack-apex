"use client";

/**
 * /emails — composer-side recipient-context drawer.
 *
 * Lives inside the composer pane, on the right edge. Default open on
 * desktop, closed on mobile/narrow. Collapsed = 36 px vertical strip
 * with a "Show context" button. Expanded = full insight cards, scoped
 * to the current draft's To: recipients.
 *
 * Behavior is identical to the prior top-level "Recipient context"
 * pane:
 *   - 0 recipients → empty hint
 *   - 1 recipient  → full insights panel
 *   - 2-5          → compact stack of per-recipient cards
 *   - 6+           → aggregate summary only
 *
 * The data + render helpers were extracted from the old
 * `page.tsx` body — this is a pure presentational component that
 * receives already-loaded insights via props.
 */

import type React from "react";

export interface RecentEmail {
  id: string;
  subject: string;
  from: string;
  fromEmail: string;
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
}

export interface CalendarEventLite {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: string[];
  attendeeEmails: string[];
}

export interface RecipientInsight {
  loading: boolean;
  recentThreads: RecentEmail[];
  lastMeeting: CalendarEventLite | null;
  summary: string;
  error: string | null;
}

export const AGGREGATE_THRESHOLD = 6;

export type InsightsMode = "empty" | "single" | "multi" | "aggregate";

interface RecipientContextDrawerProps {
  open: boolean;
  onToggle: () => void;
  recipients: string[];
  insightsCache: Record<string, RecipientInsight>;
  expandedRecipients: Set<string>;
  onToggleRecipientCard: (recipient: string) => void;
  /** Pre-fetched calendar events (year window) for aggregate mode. */
  calendarEvents: CalendarEventLite[];
}

function daysAgo(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return -1;
  return Math.max(0, Math.round((Date.now() - t) / (1000 * 60 * 60 * 24)));
}

function formatRelative(iso: string): string {
  const d = daysAgo(iso);
  if (d < 0) return "—";
  if (d === 0) return "today";
  if (d === 1) return "1 day ago";
  if (d < 30) return `${d} days ago`;
  const months = Math.round(d / 30);
  if (months < 12) return months <= 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.round(d / 365);
  return years <= 1 ? "1 year ago" : `${years} years ago`;
}

export default function RecipientContextDrawer({
  open,
  onToggle,
  recipients,
  insightsCache,
  expandedRecipients,
  onToggleRecipientCard,
  calendarEvents,
}: RecipientContextDrawerProps) {
  const recipientCount = recipients.length;
  const mode: InsightsMode =
    recipientCount === 0
      ? "empty"
      : recipientCount === 1
        ? "single"
        : recipientCount >= AGGREGATE_THRESHOLD
          ? "aggregate"
          : "multi";

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        data-testid="recipient-context-rail-collapsed"
        aria-label="Show recipient context"
        aria-expanded={false}
        style={collapsedStripStyle}
      >
        <span style={collapsedLabel}>Context</span>
      </button>
    );
  }

  return (
    <aside
      style={drawerStyle}
      aria-label="Recipient insights"
      data-testid="insights-panel"
      data-open="true"
    >
      <header style={drawerHeader}>
        <span style={drawerTitle}>Recipient context</span>
        <button
          type="button"
          onClick={onToggle}
          data-testid="recipient-context-toggle"
          aria-label="Hide recipient context"
          aria-expanded={true}
          style={iconBtn}
        >
          ›
        </button>
      </header>

      <div style={drawerBody}>
        {mode === "empty" && (
          <p style={dimText} data-testid="insight-empty">
            Add a To: recipient to see recent threads, last meeting, and
            an AI-summary of past correspondence.
          </p>
        )}
        {mode === "single" && renderSinglePanel(recipients[0]!, insightsCache)}
        {mode === "multi" &&
          renderMultiPanel(
            recipients,
            insightsCache,
            expandedRecipients,
            onToggleRecipientCard,
          )}
        {mode === "aggregate" &&
          renderAggregatePanel(recipients, calendarEvents)}
      </div>
    </aside>
  );
}

function getCachedInsight(
  email: string,
  cache: Record<string, RecipientInsight>,
): RecipientInsight | undefined {
  return cache[email.toLowerCase()];
}

function renderSinglePanel(
  recipient: string,
  cache: Record<string, RecipientInsight>,
) {
  const ins = getCachedInsight(recipient, cache);
  if (!ins || ins.loading) {
    return (
      <p style={dimText}>Loading insights for {recipient}…</p>
    );
  }
  return (
    <>
      <div style={insightCell} data-testid="insight-recipient">
        <span style={cellLabel}>Recipient</span>
        <span style={cellValue}>{recipient}</span>
      </div>

      <div style={insightCell} data-testid="insight-recent-threads">
        <span style={cellLabel}>
          Recent threads ({ins.recentThreads.length})
        </span>
        {ins.recentThreads.length === 0 ? (
          <span style={{ ...cellValue, color: "var(--wp-text-dim)" }}>
            No prior emails found.
          </span>
        ) : (
          <ul style={threadList}>
            {ins.recentThreads.map((t) => (
              <li key={t.id} style={threadItem}>
                <span style={threadSubject}>{t.subject || "(no subject)"}</span>
                <span style={threadMeta}>
                  {formatRelative(t.receivedDateTime)} · {t.from}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={insightCell} data-testid="insight-last-meeting">
        <span style={cellLabel}>Last meeting</span>
        {ins.lastMeeting ? (
          <>
            <span style={cellValue}>{ins.lastMeeting.subject}</span>
            <span
              style={{
                ...cellValue,
                color: "var(--wp-text-dim)",
                fontSize: "0.75rem",
              }}
            >
              {formatRelative(ins.lastMeeting.start)}
            </span>
          </>
        ) : (
          <span style={{ ...cellValue, color: "var(--wp-text-dim)" }}>
            No past meeting in the last year.
          </span>
        )}
      </div>

      {ins.summary && (
        <div style={insightCell} data-testid="insight-summary">
          <span style={cellLabel}>Last message preview</span>
          <span
            style={{
              ...cellValue,
              color: "var(--wp-text-dim)",
              fontSize: "0.78rem",
            }}
          >
            {ins.summary}
          </span>
        </div>
      )}
    </>
  );
}

function renderMultiPanel(
  recipients: string[],
  cache: Record<string, RecipientInsight>,
  expanded: Set<string>,
  onToggle: (r: string) => void,
) {
  return (
    <div
      data-testid="insight-multi"
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
    >
      <span style={{ fontSize: "0.72rem", color: "var(--wp-text-dim)" }}>
        {recipients.length} recipients · click a card to expand
      </span>
      {recipients.map((r) => {
        const key = r.toLowerCase();
        const ins = getCachedInsight(r, cache);
        const isExpanded = expanded.has(key);
        const threadCount = ins?.recentThreads.length ?? 0;
        const lastMtg = ins?.lastMeeting?.start ?? null;
        return (
          <div
            key={r}
            data-testid={`recipient-card-${r}`}
            style={{
              ...insightCell,
              padding: "0.5rem 0.6rem",
              cursor: "pointer",
            }}
            onClick={() => onToggle(r)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle(r);
              }
            }}
          >
            <span style={cellValue}>{r}</span>
            <span style={{ fontSize: "0.7rem", color: "var(--wp-text-dim)" }}>
              {ins?.loading
                ? "loading…"
                : `${threadCount} recent thread${threadCount === 1 ? "" : "s"} · last meeting: ${
                    lastMtg ? formatRelative(lastMtg) : "—"
                  }`}
            </span>
            {isExpanded && ins && !ins.loading && (
              <div
                data-testid={`recipient-card-expanded-${r}`}
                style={{
                  marginTop: "0.5rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.4rem",
                }}
              >
                {ins.recentThreads.length > 0 && (
                  <ul style={threadList}>
                    {ins.recentThreads.slice(0, 3).map((t) => (
                      <li key={t.id} style={threadItem}>
                        <span style={threadSubject}>
                          {t.subject || "(no subject)"}
                        </span>
                        <span style={threadMeta}>
                          {formatRelative(t.receivedDateTime)} · {t.from}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {ins.lastMeeting && (
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--wp-text-dim)",
                    }}
                  >
                    Last meeting: {ins.lastMeeting.subject} (
                    {formatRelative(ins.lastMeeting.start)})
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function renderAggregatePanel(
  recipients: string[],
  events: CalendarEventLite[],
) {
  const recipLowers = new Set(recipients.map((r) => r.toLowerCase()));
  const matching = events
    .filter((ev) => {
      const emails = (ev.attendeeEmails ?? []).map((e) => e.toLowerCase());
      return emails.some((e) => recipLowers.has(e));
    })
    .filter((ev) => {
      const t = Date.parse(ev.start);
      return !Number.isNaN(t) && t <= Date.now();
    })
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  const earliestLastMeeting = matching[matching.length - 1] ?? null;
  const mostRecentMeeting = matching[0] ?? null;

  return (
    <div
      data-testid="insight-aggregate"
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
    >
      <div style={insightCell}>
        <span style={cellLabel}>Recipients</span>
        <span style={cellValue}>{recipients.length}+ recipients</span>
        <span style={{ fontSize: "0.72rem", color: "var(--wp-text-dim)" }}>
          Per-recipient context skipped to protect Graph quota.
        </span>
      </div>
      <div style={insightCell}>
        <span style={cellLabel}>Earliest last-meeting</span>
        <span style={cellValue}>
          {earliestLastMeeting
            ? `${earliestLastMeeting.subject} (${formatRelative(earliestLastMeeting.start)})`
            : "—"}
        </span>
      </div>
      <div style={insightCell}>
        <span style={cellLabel}>Most recent meeting</span>
        <span style={cellValue}>
          {mostRecentMeeting
            ? `${mostRecentMeeting.subject} (${formatRelative(mostRecentMeeting.start)})`
            : "—"}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const drawerStyle: React.CSSProperties = {
  width: 280,
  flexShrink: 0,
  background: "var(--wp-dark-surface)",
  borderLeft: "1px solid var(--wp-dark-border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  minHeight: 0,
};

const drawerHeader: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  borderBottom: "1px solid var(--wp-dark-border)",
  background: "var(--wp-dark-surface2)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const drawerTitle: React.CSSProperties = {
  color: "var(--wp-gold)",
  fontWeight: 600,
  fontSize: "0.85rem",
};

const drawerBody: React.CSSProperties = {
  padding: "0.65rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.65rem",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

const collapsedStripStyle: React.CSSProperties = {
  width: 36,
  flexShrink: 0,
  background: "var(--wp-dark-surface2)",
  borderLeft: "1px solid var(--wp-dark-border)",
  border: "none",
  cursor: "pointer",
  color: "var(--wp-text-dim)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

const collapsedLabel: React.CSSProperties = {
  writingMode: "vertical-rl",
  transform: "rotate(180deg)",
  fontSize: "0.7rem",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const iconBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wp-text-dim)",
  cursor: "pointer",
  fontSize: "1rem",
  padding: "0.1rem 0.4rem",
  lineHeight: 1,
};

const dimText: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--wp-text-dim)",
  margin: 0,
};

const insightCell: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: "0.5rem 0.6rem",
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: "6px",
};

const cellLabel: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--wp-text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const cellValue: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "var(--wp-text)",
  wordBreak: "break-word",
};

const threadList: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const threadItem: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

const threadSubject: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--wp-text)",
};

const threadMeta: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "var(--wp-text-dim)",
};
