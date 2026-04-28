"use client";

/**
 * TicketThread — chronological message log for a support ticket.
 *
 * Renders the original inbound email, customer replies, and operator
 * outbound responses for a single ticket. Each entry shows direction
 * (inbound / outbound), the from address, a relative timestamp, and the
 * body text with line breaks preserved. Long bodies are truncated to
 * 500 chars with a "Show more" expand control so the page stays
 * scannable when a thread grows long.
 *
 * Empty state: "No messages on this ticket yet" — only meaningful for
 * form-created internal tickets that have no inbound email. Email
 * ingested tickets always have at least one message.
 *
 * Color tokens match the existing palette:
 *   inbound  = rgba(82,154,232,*)  blue/info
 *   outbound = rgba(80,175,110,*)  green/success
 */

import { useState } from "react";

export type TicketMessageDirection = "inbound" | "outbound";

export interface TicketMessage {
  id: string;
  ticket_id: string;
  direction: TicketMessageDirection;
  from_email: string | null;
  to_email?: string | null;
  subject?: string | null;
  body: string;
  received_at: string;
  /**
   * True when this outbound message was the auto-acknowledgement reply
   * the system sent before a human operator looked at the ticket.
   * Surfaces a "Auto-acknowledged" badge so the operator knows what's
   * already been said to the customer before they manually reply.
   *
   * Sourced from the parallel auto-ack backend (migration 104) which
   * marks the row by matching its `graph_message_id` against the
   * ticket's `auto_acknowledge_message_id`. When the backend hasn't
   * shipped yet, this field is simply absent and the badge does not
   * render — UI never breaks on missing data.
   */
  is_auto_acknowledge?: boolean | null;
}

const TRUNCATE_AT = 500;

/** Convert an ISO timestamp into a compact relative label. */
export function formatRelativeTime(ts: string, now: number = Date.now()): string {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "";
  const diffMs = Math.max(0, now - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export interface TicketThreadProps {
  thread: TicketMessage[] | null | undefined;
}

export default function TicketThread({ thread }: TicketThreadProps) {
  const items = Array.isArray(thread) ? thread : [];

  return (
    <section
      data-testid="ticket-thread"
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        padding: "1.1rem 1.2rem",
        marginBottom: "1.2rem",
      }}
    >
      <h2
        style={{
          margin: "0 0 0.8rem",
          fontSize: "0.92rem",
          color: "var(--wp-text-dim)",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        Conversation
      </h2>

      {items.length === 0 ? (
        <p
          data-testid="ticket-thread-empty"
          style={{
            margin: 0,
            color: "var(--wp-text-dim)",
            fontSize: "0.9rem",
          }}
        >
          No messages on this ticket yet.
        </p>
      ) : (
        <ol
          data-testid="ticket-thread-list"
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.8rem",
          }}
        >
          {items.map((msg) => (
            <ThreadMessage key={msg.id} msg={msg} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ThreadMessage({ msg }: { msg: TicketMessage }) {
  const [expanded, setExpanded] = useState(false);
  const inbound = msg.direction === "inbound";
  const isAutoAck = msg.direction === "outbound" && msg.is_auto_acknowledge === true;
  const tooLong = msg.body.length > TRUNCATE_AT;
  const visibleBody =
    !tooLong || expanded ? msg.body : msg.body.slice(0, TRUNCATE_AT);

  /* Direction tokens. Blue for inbound (customer wrote in), green for
     outbound (operator replied). The chevron points toward the actor:
     left (incoming) for inbound, right (outgoing) for outbound. */
  const accent = inbound
    ? {
        bg: "rgba(82,154,232,0.12)",
        border: "rgba(82,154,232,0.45)",
        text: "rgb(140,185,235)",
        glyph: "‹",
        label: "Inbound",
      }
    : {
        bg: "rgba(80,175,110,0.12)",
        border: "rgba(80,175,110,0.45)",
        text: "rgb(120,210,150)",
        glyph: "›",
        label: "Outbound",
      };

  return (
    <li
      data-testid="ticket-thread-message"
      data-direction={msg.direction}
      data-auto-acknowledge={isAutoAck ? "true" : "false"}
      style={{
        background: "var(--wp-dark)",
        border: `1px solid var(--wp-border, var(--wp-dark-border))`,
        borderLeft: `4px solid ${accent.border}`,
        borderRadius: 6,
        padding: "0.8rem 0.95rem",
      }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          alignItems: "center",
          marginBottom: "0.45rem",
        }}
      >
        <span
          data-testid="ticket-thread-direction-badge"
          aria-label={accent.label}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
            background: accent.bg,
            color: accent.text,
            padding: "0.15rem 0.5rem",
            borderRadius: 999,
            fontSize: "0.72rem",
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          <span aria-hidden style={{ fontSize: "0.95rem", lineHeight: 1 }}>
            {accent.glyph}
          </span>
          {accent.label}
        </span>
        <span
          data-testid="ticket-thread-from"
          style={{
            fontSize: "0.83rem",
            color: "var(--wp-text)",
            fontWeight: 500,
            wordBreak: "break-word",
          }}
        >
          {msg.from_email ?? "(unknown sender)"}
        </span>
        {isAutoAck ? (
          <span
            data-testid="ticket-thread-auto-ack-badge"
            aria-label="Auto-acknowledged"
            title="This reply was sent automatically before a human operator looked at the ticket"
            style={{
              display: "inline-flex",
              alignItems: "center",
              background: "rgba(82,154,232,0.18)",
              color: "rgb(140,185,235)",
              padding: "0.1rem 0.45rem",
              borderRadius: 999,
              fontSize: "0.7rem",
              fontWeight: 600,
              letterSpacing: "0.02em",
              border: "1px solid rgba(82,154,232,0.32)",
            }}
          >
            Auto-acknowledged
          </span>
        ) : null}
        <span
          data-testid="ticket-thread-time"
          style={{
            fontSize: "0.78rem",
            color: "var(--wp-text-dim)",
            marginLeft: "auto",
          }}
        >
          {formatRelativeTime(msg.received_at)}
        </span>
      </header>

      <p
        data-testid="ticket-thread-body"
        style={{
          margin: 0,
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
          color: "var(--wp-text)",
          fontSize: "0.9rem",
          wordBreak: "break-word",
        }}
      >
        {visibleBody}
        {tooLong && !expanded ? "…" : ""}
      </p>

      {tooLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-testid="ticket-thread-toggle"
          style={{
            marginTop: "0.5rem",
            background: "transparent",
            border: "none",
            padding: 0,
            color: "rgb(140,185,235)",
            fontSize: "0.82rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </li>
  );
}
