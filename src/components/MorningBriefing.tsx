"use client";

import { useState, useEffect, useCallback } from "react";
import { getInstinctToken, authHeaders } from "@/lib/client-auth";
import MeetingPreBriefPanel from "@/components/MeetingPreBriefPanel";

// ---------------------------------------------------------------------------
// Types (mirrors MorningBriefing from lib/morning-briefing.ts)
// ---------------------------------------------------------------------------

interface CalendarEvent {
  subject: string;
  startTime: string;
  endTime: string;
  attendees: string[];
  location?: string;
}

interface ImportantEmail {
  from: string;
  subject: string;
  receivedAt: string;
  preview: string;
  /** Microsoft Graph message id, surfaced for in-app /emails fallback. */
  id?: string;
  /** Outlook webLink — when set, the inbox card links the user out
   *  to their real mailbox instead of the in-app reader. */
  webLink?: string;
}

interface ActionItem {
  priority: "high" | "medium" | "low";
  text: string;
  context: string;
  /** Optional click-through URL — internal path or external Outlook
   *  webLink. Internal paths get pushed into the SPA; external (http/https)
   *  open in a new tab. */
  link?: string;
  source?: "email" | "meeting" | "invoice" | "client" | "receivable";
}

interface ClientAttention {
  name: string;
  reason: string;
  lastContact: string | null;
}

interface BriefingData {
  generatedAt: string;
  greeting: string;
  summary: string;
  calendar: {
    eventCount: number;
    nextEvent: { subject: string; startTime: string; attendees: string[] } | null;
    events: CalendarEvent[];
  };
  email: {
    unreadCount: number;
    importantEmails: ImportantEmail[];
  };
  financial: {
    cashPosition: number;
    revenueThisMonth: number;
    netProfit: number;
    unpaidInvoiceCount: number;
    overdueCount: number;
    recentPayments: { customer: string; amount: number }[];
  };
  clients: {
    needingAttention: ClientAttention[];
  };
  team: {
    activeMembers: number;
    recentHighlights: string[];
  };
  actionItems: ActionItem[];
  notConnected?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToken(): string {
  return getInstinctToken() || "";
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatTimeRange(start: string, end: string): string {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

const PRIORITY_STYLES: Record<ActionItem["priority"], { bg: string; text: string; label: string }> = {
  high: { bg: "rgba(239, 68, 68, 0.15)", text: "var(--wp-error)", label: "High" },
  medium: { bg: "rgba(234, 179, 8, 0.15)", text: "var(--wp-warning)", label: "Med" },
  low: { bg: "rgba(107, 114, 128, 0.15)", text: "var(--wp-text-dim)", label: "Low" },
};

// ---------------------------------------------------------------------------
// Collapsible Section
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ background: "var(--wp-dark-surface2)", borderColor: "var(--wp-dark-border)" }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors"
        style={{ background: open ? "var(--wp-dark-surface2)" : "transparent" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-xs transition-transform"
            style={{
              color: "var(--wp-text-dim)",
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              display: "inline-block",
            }}
          >
            &#9654;
          </span>
          <span className="text-sm font-semibold" style={{ color: "var(--wp-gold)" }}>
            {title}
          </span>
        </div>
        {badge !== undefined && (
          <span
            className="text-xs px-2 py-0.5 rounded-full font-medium"
            style={{ background: "rgba(212, 175, 55, 0.15)", color: "var(--wp-gold)" }}
          >
            {badge}
          </span>
        )}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MorningBriefing() {
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBriefing = useCallback(async (refresh = false) => {
    try {
      if (refresh) setRefreshing(true);
      // Pass the browser's IANA timezone so the server computes the calendar
      // window for the user's LOCAL day, not a UTC slice that combines two
      // local days (the "yesterday's meetings shown as today's" bug).
      const params = new URLSearchParams();
      if (refresh) params.set("refresh", "true");
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) params.set("tz", tz);
      const url = `/api/briefing?${params.toString()}`;
      const res = await fetch(url, {
        headers: authHeaders(),
      });
      if (res.status === 401 || res.status === 403) {
        setError("restricted");
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch briefing");
      const data = await res.json();
      setBriefing(data);
      setError(null);
    } catch {
      setError("Unable to load morning briefing");
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchBriefing();
  }, [fetchBriefing]);

  // Don't render for non-CEO/CTO
  if (error === "restricted") return null;

  if (loading) {
    return (
      <div
        className="rounded-lg p-6 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full animate-pulse"
            style={{ background: "var(--wp-dark-surface2)" }}
          />
          <div className="space-y-2 flex-1">
            <div
              className="h-5 w-48 rounded animate-pulse"
              style={{ background: "var(--wp-dark-surface2)" }}
            />
            <div
              className="h-4 w-72 rounded animate-pulse"
              style={{ background: "var(--wp-dark-surface2)" }}
            />
          </div>
        </div>
      </div>
    );
  }

  if (error || !briefing) {
    return (
      <div
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
          {error || "Unable to load briefing"}
        </p>
      </div>
    );
  }

  // Not connected: show connect prompt instead of demo data
  if (briefing.notConnected) {
    return (
      <div
        className="rounded-lg p-5 border"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h2 className="text-xl font-bold mb-2" style={{ color: "var(--wp-gold)" }}>
          {briefing.greeting}
        </h2>
        <p className="text-sm mb-4" style={{ color: "var(--wp-text-dim)" }}>
          Connect your accounts to unlock your personalized daily briefing with calendar events, email highlights, financial snapshot, and smart action items.
        </p>
        <a
          href="/settings"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.07a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.343 8.07" />
          </svg>
          Connect in Settings
        </a>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg p-5 border space-y-4"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      {/* Header: Greeting + Summary + Refresh */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold" style={{ color: "var(--wp-gold)" }}>
            {briefing.greeting}
          </h2>
          <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
            {briefing.summary}
          </p>
        </div>
        <button
          onClick={() => fetchBriefing(true)}
          disabled={refreshing}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: refreshing ? "var(--wp-text-muted)" : "var(--wp-text-dim)",
          }}
        >
          <span
            className={refreshing ? "animate-spin" : ""}
            style={{ display: "inline-block" }}
          >
            &#8635;
          </span>
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Today's Schedule (left) + Action Items (right) half-width pair */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Today's Schedule */}
        <Section
          title="Today's Schedule"
          badge={briefing.calendar.eventCount > 0 ? briefing.calendar.eventCount : undefined}
        >
          {briefing.calendar.events.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
              No meetings scheduled today.
            </p>
          ) : (
            <div className="space-y-2">
              {briefing.calendar.events.map((event, i) => (
                <div
                  key={i}
                  className="flex gap-3 rounded-lg p-3 border"
                  style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
                >
                  <div
                    className="shrink-0 w-1 rounded-full"
                    style={{ background: "var(--wp-gold)" }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>
                      {event.subject}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--wp-text-dim)" }}>
                      {formatTimeRange(event.startTime, event.endTime)}
                      {event.location && ` \u00B7 ${event.location}`}
                    </p>
                    {event.attendees.length > 0 && (
                      <p className="text-xs mt-0.5" style={{ color: "var(--wp-text-muted)" }}>
                        {event.attendees.join(", ")}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Action Items (right column) */}
        {briefing.actionItems.length > 0 ? (
          <Section title="Action Items" badge={briefing.actionItems.length}>
            <div className="space-y-2">
              {briefing.actionItems.map((item, i) => {
                const style = PRIORITY_STYLES[item.priority];
                /* External links open in a new tab; internal paths use the
                   browser's default navigation. Both fire a fire-and-forget
                   analytics POST so dashboard.action_item_clicked makes it
                   into the learning loop. */
                const isExternal = !!item.link && /^https?:\/\//i.test(item.link);
                const handleClick = () => {
                  if (!item.link) return;
                  void fetch("/api/analytics", {
                    method: "POST",
                    headers: {
                      ...authHeaders(),
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      event: "dashboard.action_item_clicked",
                      metadata: {
                        priority: item.priority,
                        source: item.source ?? "unknown",
                        is_external: isExternal,
                      },
                    }),
                    keepalive: true,
                  }).catch(() => undefined);
                };
                const cardInner = (
                  <>
                    <span
                      className="shrink-0 text-xs font-bold px-2 py-0.5 rounded-full mt-0.5"
                      style={{ background: style.bg, color: style.text }}
                    >
                      {style.label}
                    </span>
                    <div className="min-w-0">
                      <p
                        className="text-sm font-medium"
                        style={{ color: "var(--wp-text)" }}
                      >
                        {item.text}
                        {item.link ? (
                          <span
                            aria-hidden="true"
                            className="ml-2 text-xs"
                            style={{ color: "var(--wp-gold)" }}
                          >
                            ↗
                          </span>
                        ) : null}
                      </p>
                      <p
                        className="text-xs mt-0.5"
                        style={{ color: "var(--wp-text-muted)" }}
                      >
                        {item.context}
                      </p>
                    </div>
                  </>
                );
                const cardClass =
                  "flex items-start gap-3 rounded-lg p-3 border" +
                  (item.link ? " wp-hover-lift cursor-pointer outline-none" : "");
                const cardStyle = {
                  background: "var(--wp-dark-surface)",
                  borderColor: "var(--wp-dark-border)",
                };
                if (item.link) {
                  return (
                    <a
                      key={i}
                      href={item.link}
                      target={isExternal ? "_blank" : undefined}
                      rel={isExternal ? "noopener noreferrer" : undefined}
                      onClick={handleClick}
                      data-testid={`action-item-link-${i}`}
                      className={cardClass}
                      style={{ ...cardStyle, textDecoration: "none" }}
                    >
                      {cardInner}
                    </a>
                  );
                }
                return (
                  <div
                    key={i}
                    data-testid={`action-item-static-${i}`}
                    className={cardClass}
                    style={cardStyle}
                  >
                    {cardInner}
                  </div>
                );
              })}
            </div>
          </Section>
        ) : (
          <Section title="Action Items">
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
              Nothing urgent — you&apos;re clear.
            </p>
          </Section>
        )}
      </div>

      {/* Meeting Pre-Brief — below the schedule/actions pair */}
      <MeetingPreBriefPanel />

      {/* Inbox — full width below pre-brief */}
      <Section
        title="Inbox"
        badge={briefing.email.unreadCount > 0 ? `${briefing.email.unreadCount} unread` : undefined}
      >
        {briefing.email.importantEmails.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
            No important emails.
          </p>
        ) : (
          <div className="space-y-2">
            {briefing.email.importantEmails.map((email, i) => {
              /* Prefer the Outlook webLink so users land in their real
                 mailbox (where they reply, archive, file). Fallback to
                 the in-app /emails reader (currently hidden from nav)
                 when the upstream MS Graph response lacks webLink. */
              const href = email.webLink
                ? email.webLink
                : email.id
                  ? `/emails?messageId=${encodeURIComponent(email.id)}`
                  : null;
              const isExternal = !!href && /^https?:\/\//i.test(href);
              const inner = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--wp-text)" }}>
                      {email.from}
                    </p>
                    <span className="text-xs shrink-0" style={{ color: "var(--wp-text-muted)" }}>
                      {formatTime(email.receivedAt)}
                    </span>
                  </div>
                  <p className="text-xs font-medium mt-1" style={{ color: "var(--wp-text-dim)" }}>
                    {email.subject}
                  </p>
                  <p className="text-xs mt-0.5 line-clamp-2" style={{ color: "var(--wp-text-muted)" }}>
                    {email.preview}
                  </p>
                </>
              );
              if (!href) {
                return (
                  <div
                    key={i}
                    className="rounded-lg p-3 border"
                    style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
                  >
                    {inner}
                  </div>
                );
              }
              return (
                <a
                  key={i}
                  href={href}
                  target={isExternal ? "_blank" : undefined}
                  rel={isExternal ? "noopener noreferrer" : undefined}
                  data-testid={`briefing-email-link-${i}`}
                  className="block rounded-lg p-3 border wp-hover-lift outline-none"
                  style={{
                    background: "var(--wp-dark-surface)",
                    borderColor: "var(--wp-dark-border)",
                    textDecoration: "none",
                  }}
                >
                  {inner}
                </a>
              );
            })}
          </div>
        )}
      </Section>

      {/* Financial Pulse (only when financial data exists) */}
      {(briefing.financial.revenueThisMonth > 0 || briefing.financial.cashPosition > 0 || briefing.financial.unpaidInvoiceCount > 0) && (
      <Section title="Financial Pulse">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {[
            {
              label: "Cash Position",
              value: formatCurrency(briefing.financial.cashPosition),
              color: briefing.financial.cashPosition > 0 ? "var(--wp-success)" : "var(--wp-error)",
            },
            {
              label: "Revenue MTD",
              value: formatCurrency(briefing.financial.revenueThisMonth),
              color: "var(--wp-gold)",
            },
            {
              label: "Net Profit MTD",
              value: formatCurrency(briefing.financial.netProfit),
              color: briefing.financial.netProfit >= 0 ? "var(--wp-success)" : "var(--wp-error)",
            },
            {
              label: "Unpaid Invoices",
              value: String(briefing.financial.unpaidInvoiceCount),
              color: briefing.financial.overdueCount > 0 ? "var(--wp-error)" : "var(--wp-warning)",
              subtitle: briefing.financial.overdueCount > 0
                ? `${briefing.financial.overdueCount} overdue`
                : undefined,
            },
          ].map((card) => (
            <div
              key={card.label}
              className="rounded-lg p-3 border"
              style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
            >
              <p className="text-lg font-bold" style={{ color: card.color }}>
                {card.value}
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--wp-text-dim)" }}>
                {card.label}
              </p>
              {"subtitle" in card && card.subtitle && (
                <p className="text-xs mt-0.5" style={{ color: "var(--wp-error)" }}>
                  {card.subtitle}
                </p>
              )}
            </div>
          ))}
        </div>
        {briefing.financial.recentPayments.length > 0 && (
          <div>
            <p className="text-xs font-medium mb-1.5" style={{ color: "var(--wp-text-dim)" }}>
              Recent Payments
            </p>
            <div className="space-y-1">
              {briefing.financial.recentPayments.map((p, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span style={{ color: "var(--wp-text)" }}>{p.customer}</span>
                  <span className="font-mono" style={{ color: "var(--wp-success)" }}>
                    +{formatCurrency(p.amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Client Attention */}
        {briefing.clients.needingAttention.length > 0 && (
          <Section
            title="Client Attention"
            badge={briefing.clients.needingAttention.length}
          >
            <div className="space-y-2">
              {briefing.clients.needingAttention.map((client, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg p-3 border"
                  style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
                >
                  <div>
                    <p className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>
                      {client.name}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--wp-warning)" }}>
                      {client.reason}
                    </p>
                  </div>
                  {client.lastContact && (
                    <span className="text-xs shrink-0" style={{ color: "var(--wp-text-muted)" }}>
                      {new Date(client.lastContact).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Team Activity */}
        <Section title="Team Activity" badge={`${briefing.team.activeMembers} active`}>
          {briefing.team.recentHighlights.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
              No recent team activity.
            </p>
          ) : (
            <div className="space-y-1.5">
              {briefing.team.recentHighlights.map((highlight, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span
                    className="shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full"
                    style={{ background: "var(--wp-gold)" }}
                  />
                  <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                    {highlight}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* Generated timestamp */}
      <p className="text-xs text-right" style={{ color: "var(--wp-text-muted)" }}>
        Generated: {new Date(briefing.generatedAt).toLocaleTimeString()}
      </p>
    </div>
  );
}
