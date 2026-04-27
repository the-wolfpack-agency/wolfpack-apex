"use client";

/**
 * TicketList — list view used by /support.
 *
 * Filter pills (All / Open / Drafted / Sent / Resolved) drive the
 * `status` query param sent to GET /api/support/tickets. Pill counts
 * come from the tickets array itself so the badges stay in sync with
 * whatever the server returned for the active filter — there's no
 * separate counts endpoint to drift from.
 *
 * Each row is a clickable card with a full-area link overlay so the
 * whole row navigates to /support/[id]. Severity badge, title, category
 * and a relative timestamp ("drafted 4 min ago" / "sent to a@b.com 2 min
 * ago") sit above the link.
 *
 * Empty state: friendly call-to-action that points to /support/new.
 */

import { useMemo } from "react";
import Link from "next/link";
import SeverityBadge, { type Severity } from "./SeverityBadge";
import StatusPill, { type TicketStatus } from "./StatusPill";
import AudienceBadge, { type Audience } from "./AudienceBadge";

export type TicketCategory =
  | "m365"
  | "azure"
  | "instinct"
  | "wolfpack-auto"
  | "general";

export interface SupportTicket {
  id: string;
  title: string;
  body: string;
  diagnostic_text?: string | null;
  category: TicketCategory;
  severity: Severity;
  status: TicketStatus;
  /* Optional so older fixtures and any pre-101 ticket blob still
     pass through TypeScript. The list defaults missing values to
     'internal' before rendering the badge. */
  audience?: Audience | null;
  draft_response?: string | null;
  drafted_at?: string | null;
  sent_response?: string | null;
  sent_to?: string | null;
  sent_at?: string | null;
  feedback_helpful?: boolean | null;
  feedback_notes?: string | null;
  matched_patterns?: string[];
  /* Email/message thread is hydrated only on the detail GET. The list
     view never includes it, so it stays optional and tolerates older
     fixtures + form-created internal tickets that have no thread. The
     concrete TicketMessage shape lives next to the renderer in
     TicketThread.tsx; the list type only cares that it's an array. */
  thread?: import("./TicketThread").TicketMessage[] | null;
  created_at: string;
  created_by?: string | null;
  updated_at?: string | null;
}

export type FilterKey = "all" | "open" | "drafted" | "sent" | "resolved";

/** Audience filter is independent from status — operators want to slice
 *  by both at once ("open client tickets" vs "drafted internal").  */
export type AudienceFilterKey = "all" | "client" | "internal";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "drafted", label: "Drafted" },
  { key: "sent", label: "Sent" },
  { key: "resolved", label: "Resolved" },
];

const AUDIENCE_FILTERS: { key: AudienceFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "client", label: "Client" },
  { key: "internal", label: "Internal" },
];

function audienceOf(t: SupportTicket): Audience {
  return t.audience === "client" ? "client" : "internal";
}

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  m365: "Microsoft 365",
  azure: "Azure",
  instinct: "Instinct",
  "wolfpack-auto": "Wolfpack Auto",
  general: "General",
};

/**
 * Plain-language relative time. Mirrors the formatter in the dashboard
 * page so the visual rhythm matches across surfaces.
 */
export function formatTimeAgo(ts?: string | null): string {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(diff)) return "";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function countByStatus(
  tickets: SupportTicket[],
  key: FilterKey,
): number {
  if (key === "all") return tickets.length;
  if (key === "open") {
    return tickets.filter((t) => t.status === "open").length;
  }
  if (key === "drafted") {
    return tickets.filter((t) => t.status === "drafted").length;
  }
  if (key === "sent") {
    return tickets.filter((t) => t.status === "sent").length;
  }
  if (key === "resolved") {
    return tickets.filter(
      (t) => t.status === "resolved" || t.status === "closed",
    ).length;
  }
  return 0;
}

export interface TicketListProps {
  tickets: SupportTicket[];
  filter: FilterKey;
  onFilterChange: (next: FilterKey) => void;
  /* Audience filter is optional so existing call sites that don't
     supply it keep working. The audience pill row simply hides when
     no handler is wired in. */
  audienceFilter?: AudienceFilterKey;
  onAudienceFilterChange?: (next: AudienceFilterKey) => void;
  loading?: boolean;
  error?: string | null;
}

export default function TicketList({
  tickets,
  filter,
  onFilterChange,
  audienceFilter = "all",
  onAudienceFilterChange,
  loading,
  error,
}: TicketListProps) {
  const counts = useMemo(() => {
    return FILTERS.reduce<Record<FilterKey, number>>((acc, f) => {
      acc[f.key] = countByStatus(tickets, f.key);
      return acc;
    }, { all: 0, open: 0, drafted: 0, sent: 0, resolved: 0 });
  }, [tickets]);

  const audienceCounts = useMemo(() => {
    let client = 0;
    let internal = 0;
    for (const t of tickets) {
      if (audienceOf(t) === "client") client += 1;
      else internal += 1;
    }
    return { all: tickets.length, client, internal };
  }, [tickets]);

  /* Apply the audience filter client-side. The list page can also send
     ?audience= to the server for a smaller payload, but doing the
     filter here too keeps the pill counts honest if the parent omits
     the server-side filter. */
  const visibleTickets = useMemo(() => {
    if (audienceFilter === "all") return tickets;
    return tickets.filter((t) => audienceOf(t) === audienceFilter);
  }, [tickets, audienceFilter]);

  return (
    <div data-testid="ticket-list-root">
      {/* Audience filter pills — sit above the status pills so the
          operator picks "who is this for" first, then "in what state". */}
      {onAudienceFilterChange && (
        <div
          role="tablist"
          aria-label="Filter tickets by audience"
          data-testid="ticket-list-audience-filters"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            marginBottom: "0.7rem",
          }}
        >
          {AUDIENCE_FILTERS.map((f) => {
            const active = audienceFilter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`ticket-audience-filter-${f.key}`}
                data-active={active ? "yes" : "no"}
                onClick={() => onAudienceFilterChange(f.key)}
                style={{
                  background: active
                    ? "rgba(82,154,232,0.18)"
                    : "var(--wp-card, var(--wp-dark-surface))",
                  color: active
                    ? "var(--wp-info, rgb(120,180,232))"
                    : "var(--wp-text)",
                  border: `1px solid ${active ? "var(--wp-info, rgb(120,180,232))" : "var(--wp-border, var(--wp-dark-border))"}`,
                  borderRadius: 999,
                  padding: "0.4rem 0.9rem",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  touchAction: "manipulation",
                }}
              >
                {f.label}{" "}
                <span
                  style={{
                    marginLeft: "0.35rem",
                    color: active
                      ? "var(--wp-info, rgb(120,180,232))"
                      : "var(--wp-text-dim)",
                    fontWeight: 500,
                  }}
                >
                  ({audienceCounts[f.key]})
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Filter pills */}
      <div
        role="tablist"
        aria-label="Filter tickets by status"
        data-testid="ticket-list-filters"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          marginBottom: "1.2rem",
        }}
      >
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`ticket-filter-${f.key}`}
              data-active={active ? "yes" : "no"}
              onClick={() => onFilterChange(f.key)}
              style={{
                background: active
                  ? "rgba(241,194,51,0.18)"
                  : "var(--wp-card, var(--wp-dark-surface))",
                color: active ? "var(--wp-gold)" : "var(--wp-text)",
                border: `1px solid ${active ? "var(--wp-gold)" : "var(--wp-border, var(--wp-dark-border))"}`,
                borderRadius: 999,
                padding: "0.4rem 0.9rem",
                fontSize: "0.85rem",
                fontWeight: 600,
                cursor: "pointer",
                touchAction: "manipulation",
              }}
            >
              {f.label}{" "}
              <span
                style={{
                  marginLeft: "0.35rem",
                  color: active ? "var(--wp-gold)" : "var(--wp-text-dim)",
                  fontWeight: 500,
                }}
              >
                ({counts[f.key]})
              </span>
            </button>
          );
        })}
      </div>

      {loading && (
        <div
          data-testid="ticket-list-loading"
          style={{ color: "var(--wp-text-dim)" }}
        >
          Loading tickets…
        </div>
      )}

      {error && (
        <div
          data-testid="ticket-list-error"
          role="alert"
          style={{
            padding: "0.7rem 0.9rem",
            background: "rgba(232,123,123,0.10)",
            border: "1px solid rgba(232,123,123,0.45)",
            borderLeftWidth: 4,
            borderRadius: 6,
            color: "var(--wp-text)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && visibleTickets.length === 0 && (
        <div
          data-testid="ticket-list-empty"
          style={{
            padding: "1.4rem",
            background: "var(--wp-card, var(--wp-dark-surface))",
            border: "1px solid var(--wp-border, var(--wp-dark-border))",
            borderRadius: 8,
            color: "var(--wp-text-dim)",
            maxWidth: 640,
          }}
        >
          {tickets.length === 0 ? (
            <>No tickets yet. Click &ldquo;New ticket&rdquo; to start.</>
          ) : (
            "No tickets match the current filters."
          )}
        </div>
      )}

      {!loading && !error && visibleTickets.length > 0 && (
        <div
          data-testid="ticket-list-rows"
          style={{ display: "grid", gap: "0.6rem" }}
        >
          {visibleTickets.map((t) => (
            <TicketRow key={t.id} ticket={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function activityLine(t: SupportTicket): string {
  if (t.status === "sent" && t.sent_at) {
    const to = t.sent_to ? ` to ${t.sent_to}` : "";
    return `Sent${to} ${formatTimeAgo(t.sent_at)}`;
  }
  if (t.status === "resolved" && t.sent_at) {
    return `Resolved ${formatTimeAgo(t.sent_at)}`;
  }
  if (t.status === "drafted" && t.drafted_at) {
    return `Drafted ${formatTimeAgo(t.drafted_at)}`;
  }
  if (t.created_at) {
    return `Opened ${formatTimeAgo(t.created_at)}`;
  }
  return "";
}

export function TicketRow({ ticket }: { ticket: SupportTicket }) {
  const href = `/support/${encodeURIComponent(ticket.id)}`;
  return (
    <div
      data-testid={`ticket-row-${ticket.id}`}
      data-status={ticket.status}
      className="ticket-row"
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        position: "relative",
        padding: "0.9rem 1rem",
      }}
    >
      <Link
        href={href}
        aria-label={`Open ticket: ${ticket.title}`}
        data-testid={`ticket-row-link-${ticket.id}`}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          borderRadius: 8,
        }}
      />
      <style jsx>{`
        .ticket-row {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .ticket-row :global(.row-meta) {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          align-items: center;
        }
        .ticket-row:hover {
          border-color: var(--wp-gold);
        }
        @media (min-width: 720px) {
          .ticket-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto auto;
            gap: 1rem;
            align-items: center;
          }
        }
      `}</style>

      <div style={{ minWidth: 0 }}>
        <div className="row-meta" style={{ marginBottom: "0.35rem" }}>
          <SeverityBadge severity={ticket.severity} />
          <StatusPill status={ticket.status} />
          <AudienceBadge audience={audienceOf(ticket)} />
          <span
            style={{
              fontSize: "0.75rem",
              color: "var(--wp-text-dim)",
            }}
          >
            {CATEGORY_LABEL[ticket.category]}
          </span>
        </div>
        <div
          style={{
            fontWeight: 600,
            fontSize: "0.98rem",
            color: "var(--wp-text)",
            wordBreak: "break-word",
          }}
        >
          {ticket.title}
        </div>
        <div
          style={{
            color: "var(--wp-text-dim)",
            fontSize: "0.8rem",
            marginTop: "0.2rem",
          }}
          data-testid={`ticket-row-activity-${ticket.id}`}
        >
          {activityLine(ticket)}
        </div>
      </div>

      <div
        aria-hidden
        style={{
          color: "var(--wp-text-dim)",
          fontSize: "1.1rem",
          alignSelf: "center",
          paddingRight: "0.2rem",
        }}
      >
        ›
      </div>
    </div>
  );
}
