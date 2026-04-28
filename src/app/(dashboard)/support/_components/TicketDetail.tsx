"use client";

/**
 * TicketDetail — full ticket page body.
 *
 * Three sections, top to bottom:
 *
 *   1. Header — title, severity, category, status, created-by line.
 *   2. Ticket body + collapsible diagnostic text.
 *   3. Either:
 *        a. Draft editor (when status ≠ sent / resolved) — operator
 *           can edit the AI draft, regenerate it, or open the send
 *           preview modal.
 *        b. Sent state — read-only sent_response + feedback widget.
 *
 * Send flow:
 *   "Send to user" opens a confirmation modal that previews exactly
 *   what will go out (To, From: support@thewolfpack.agency, Subject,
 *   Body). Only the modal's "Send to <email>" button calls POST
 *   /api/support/tickets/[id]/send. Optimistic update: the response
 *   ticket is patched into local state without a refetch so the page
 *   immediately flips to its sent presentation.
 *
 * Edit-diff capture:
 *   When the operator submits feedback, we send `{ original,
 *   edited }` for the draft → sent transition so the backend can
 *   compute a real diff for the learning loop. Storing the pair, not
 *   the diff, keeps the client side dumb.
 */

import { useMemo, useState } from "react";
import { fetchWithRefresh, getInstinctUser } from "@/lib/client-auth";
import SeverityBadge from "./SeverityBadge";
import StatusPill from "./StatusPill";
import AudienceBadge, { type Audience } from "./AudienceBadge";
import TicketThread, { type TicketMessage } from "./TicketThread";
import type { SupportTicket, TicketCategory } from "./TicketList";

function audienceOf(t: SupportTicket): Audience {
  return t.audience === "client" ? "client" : "internal";
}

/**
 * Resolve the From: address for the send modal based on audience.
 *   client   → support@thewolfpack.agency
 *   internal → operator's own email (looked up from the auth user blob)
 *              with a graceful fallback to the support address when the
 *              user blob lacks an email so we never render an empty
 *              From: line.
 */
function fromAddressFor(
  audience: Audience,
  operatorEmailFallback: string | null,
): string {
  if (audience === "client") return SUPPORT_FROM_ADDRESS;
  return operatorEmailFallback ?? SUPPORT_FROM_ADDRESS;
}

interface OperatorUser {
  email?: string | null;
}

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  m365: "Microsoft 365",
  azure: "Azure",
  instinct: "Instinct",
  "wolfpack-auto": "Wolfpack Auto",
  "porsche-classes": "Porsche Classes",
  billing: "Billing",
  urgent: "Urgent",
  general: "General",
};

/**
 * All operator-selectable categories, in the order shown in the
 * "Change category" picker. Matches the categorizer's allowed values
 * one-to-one so the picker can't pick anything the backend refuses.
 */
const CATEGORY_OPTIONS: TicketCategory[] = [
  "m365",
  "azure",
  "instinct",
  "wolfpack-auto",
  "porsche-classes",
  "billing",
  "urgent",
  "general",
];

function categoryOf(t: SupportTicket): TicketCategory {
  return (CATEGORY_OPTIONS as readonly string[]).includes(t.category)
    ? (t.category as TicketCategory)
    : "general";
}

const SUPPORT_FROM_ADDRESS = "support@thewolfpack.agency";

function formatDateTime(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Heuristic recipient inference. Looks for the first email address in
 * either the body or the diagnostic text. If nothing matches, the user
 * has to type a recipient — never silently fail.
 */
export function inferRecipient(t: SupportTicket): string {
  const haystack = `${t.body ?? ""}\n${t.diagnostic_text ?? ""}`;
  const m = haystack.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0] : "";
}

export interface TicketDetailProps {
  ticket: SupportTicket;
  onTicketUpdated: (next: SupportTicket) => void;
}

export default function TicketDetail({
  ticket,
  onTicketUpdated,
}: TicketDetailProps) {
  const [draftText, setDraftText] = useState<string>(
    ticket.draft_response ?? "",
  );
  const [regenerating, setRegenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [showSendModal, setShowSendModal] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);

  const sentOrResolved =
    ticket.status === "sent" || ticket.status === "resolved";

  /* Sync local edits when the parent swaps in a fresh ticket (e.g.
     after regenerate or a navigation that reloads from the API). */
  const ticketDraftKey = `${ticket.id}:${ticket.drafted_at ?? ""}`;
  useMemo(() => {
    setDraftText(ticket.draft_response ?? "");
    return ticketDraftKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketDraftKey]);

  async function handleRegenerate() {
    setRegenerating(true);
    setActionError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/support/tickets/${encodeURIComponent(ticket.id)}/draft`,
        { method: "POST" },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setActionError(
          errBody.error ??
            "We couldn't regenerate the draft. Try again in a moment.",
        );
        return;
      }
      const data = (await res.json()) as
        | SupportTicket
        | { ticket: SupportTicket };
      const fresh =
        data && typeof data === "object" && "ticket" in data
          ? (data as { ticket: SupportTicket }).ticket
          : (data as SupportTicket);
      onTicketUpdated(fresh);
      setDraftText(fresh.draft_response ?? "");
    } catch (err) {
      setActionError(
        `Something went wrong regenerating the draft: ${(err as Error).message}`,
      );
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <div data-testid="ticket-detail-root">
      {/* Header */}
      <div data-testid="ticket-detail-header" style={{ marginBottom: "1.4rem" }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            alignItems: "center",
            marginBottom: "0.5rem",
          }}
        >
          <SeverityBadge severity={ticket.severity} />
          <StatusPill status={ticket.status} />
          <AudienceBadge audience={audienceOf(ticket)} />
          <CategoryChip
            ticket={ticket}
            onTicketUpdated={onTicketUpdated}
          />
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: "1.55rem",
            color: "var(--wp-text)",
            wordBreak: "break-word",
          }}
        >
          {ticket.title}
        </h1>
        <p
          style={{
            margin: "0.35rem 0 0",
            color: "var(--wp-text-dim)",
            fontSize: "0.85rem",
          }}
          data-testid="ticket-detail-meta"
        >
          {ticket.created_by ? `Created by ${ticket.created_by}` : "Created"}
          {ticket.created_at ? ` at ${formatDateTime(ticket.created_at)}` : ""}
        </p>
      </div>

      {/* Body section */}
      <section
        data-testid="ticket-detail-body"
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
            margin: "0 0 0.6rem",
            fontSize: "0.92rem",
            color: "var(--wp-text-dim)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          What was reported
        </h2>
        <p
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
            color: "var(--wp-text)",
          }}
        >
          {ticket.body}
        </p>
        {ticket.diagnostic_text && (
          <details
            data-testid="ticket-detail-diagnostic"
            open={diagnosticOpen}
            onToggle={(e) =>
              setDiagnosticOpen((e.target as HTMLDetailsElement).open)
            }
            style={{ marginTop: "0.9rem" }}
          >
            <summary
              style={{
                cursor: "pointer",
                fontSize: "0.85rem",
                color: "var(--wp-text-dim)",
                userSelect: "none",
              }}
            >
              {diagnosticOpen
                ? "Hide diagnostic text"
                : "Show diagnostic text"}
            </summary>
            <pre
              style={{
                marginTop: "0.6rem",
                padding: "0.7rem 0.9rem",
                background: "var(--wp-dark)",
                border: "1px solid var(--wp-border, var(--wp-dark-border))",
                borderRadius: 6,
                fontSize: "0.8rem",
                color: "var(--wp-text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              {ticket.diagnostic_text}
            </pre>
          </details>
        )}
      </section>

      {/* Conversation thread — inbound email + customer replies +
          operator outbound replies. Only rendered when the ticket has
          messages so form-created internal tickets without an inbound
          email don't show an empty card. */}
      {ticket.thread && ticket.thread.length > 0 && (
        <TicketThread thread={ticket.thread as TicketMessage[]} />
      )}

      {/* Draft editor (pre-send) OR sent presentation */}
      {!sentOrResolved ? (
        <DraftEditor
          ticket={ticket}
          draftText={draftText}
          onDraftTextChange={setDraftText}
          regenerating={regenerating}
          onRegenerate={handleRegenerate}
          onOpenSend={() => setShowSendModal(true)}
          actionError={actionError}
        />
      ) : (
        <SentPanel
          ticket={ticket}
          onTicketUpdated={onTicketUpdated}
        />
      )}

      {showSendModal && (
        <SendModal
          ticket={ticket}
          draftText={draftText}
          onClose={() => setShowSendModal(false)}
          onSent={(next) => {
            onTicketUpdated(next);
            setShowSendModal(false);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Draft editor                                                        */
/* ------------------------------------------------------------------ */

function DraftEditor({
  ticket,
  draftText,
  onDraftTextChange,
  regenerating,
  onRegenerate,
  onOpenSend,
  actionError,
}: {
  ticket: SupportTicket;
  draftText: string;
  onDraftTextChange: (next: string) => void;
  regenerating: boolean;
  onRegenerate: () => void;
  onOpenSend: () => void;
  actionError: string | null;
}) {
  const matched = ticket.matched_patterns ?? [];
  const canSend = !regenerating && draftText.trim().length > 0;

  return (
    <section
      data-testid="ticket-detail-draft"
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        padding: "1.1rem 1.2rem",
      }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.6rem",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.6rem",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: "0.92rem",
            color: "var(--wp-text-dim)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          AI draft response
        </h2>
        {matched.length > 0 && (
          <div
            data-testid="ticket-detail-matches"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.35rem",
            }}
          >
            {matched.map((m) => (
              <span
                key={m}
                style={{
                  background: "rgba(80,175,110,0.18)",
                  color: "rgb(120,210,150)",
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  padding: "0.18rem 0.5rem",
                  borderRadius: 999,
                }}
              >
                Matched: {m}
              </span>
            ))}
          </div>
        )}
      </header>

      {regenerating ? (
        <DraftSkeleton />
      ) : (
        <textarea
          value={draftText}
          onChange={(e) => onDraftTextChange(e.target.value)}
          data-testid="ticket-detail-draft-textarea"
          rows={12}
          placeholder="The AI draft will appear here. Edit freely before sending."
          style={{
            width: "100%",
            padding: "0.8rem 0.9rem",
            background: "var(--wp-dark)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-border, var(--wp-dark-border))",
            borderRadius: 6,
            fontSize: "0.92rem",
            fontFamily: "inherit",
            lineHeight: 1.5,
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
      )}

      {actionError && (
        <p
          role="alert"
          data-testid="ticket-detail-draft-error"
          style={{
            margin: "0.6rem 0 0",
            fontSize: "0.85rem",
            color: "rgb(232,123,123)",
          }}
        >
          {actionError}
        </p>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.6rem",
          marginTop: "0.9rem",
        }}
      >
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          data-testid="ticket-detail-regenerate"
          style={{
            background: "transparent",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-border, var(--wp-dark-border))",
            padding: "0.55rem 1rem",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: "0.88rem",
            cursor: regenerating ? "not-allowed" : "pointer",
          }}
        >
          {regenerating ? "Regenerating draft…" : "Regenerate draft"}
        </button>
        <button
          type="button"
          onClick={onOpenSend}
          disabled={!canSend}
          data-testid="ticket-detail-open-send"
          style={{
            background: canSend
              ? "var(--wp-gold)"
              : "var(--wp-border, var(--wp-dark-border))",
            color: canSend ? "var(--wp-dark)" : "var(--wp-text-dim)",
            border: "none",
            padding: "0.55rem 1.1rem",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: "0.88rem",
            cursor: canSend ? "pointer" : "not-allowed",
          }}
        >
          Send to user
        </button>
      </div>
    </section>
  );
}

function DraftSkeleton() {
  return (
    <div data-testid="ticket-detail-draft-skeleton">
      <p
        style={{
          margin: "0 0 0.5rem",
          color: "var(--wp-text-dim)",
          fontSize: "0.85rem",
        }}
      >
        Drafting response…
      </p>
      {[100, 90, 95, 80, 70].map((w, i) => (
        <div
          key={i}
          aria-hidden
          style={{
            height: 10,
            width: `${w}%`,
            borderRadius: 4,
            marginBottom: "0.5rem",
            background:
              "linear-gradient(90deg, rgba(241,194,51,0.10) 0%, rgba(241,194,51,0.30) 50%, rgba(241,194,51,0.10) 100%)",
            backgroundSize: "200% 100%",
            animation: "draft-shimmer 1.4s ease-in-out infinite",
          }}
        />
      ))}
      <style jsx>{`
        @keyframes draft-shimmer {
          0% {
            background-position: 200% 0;
          }
          100% {
            background-position: -200% 0;
          }
        }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Send modal                                                          */
/* ------------------------------------------------------------------ */

function SendModal({
  ticket,
  draftText,
  onClose,
  onSent,
}: {
  ticket: SupportTicket;
  draftText: string;
  onClose: () => void;
  onSent: (next: SupportTicket) => void;
}) {
  /* Operator email is read once on mount from the auth user blob. The
     getInstinctUser helper safely returns null in SSR + missing-blob
     scenarios so we degrade to the support address rather than render
     an empty From: line. */
  const operatorEmail = useMemo<string | null>(() => {
    const u = getInstinctUser<OperatorUser>();
    return u && typeof u.email === "string" && u.email.length > 0
      ? u.email
      : null;
  }, []);
  const audience = audienceOf(ticket);
  const [fromEmail, setFromEmail] = useState<string>(
    fromAddressFor(audience, operatorEmail),
  );
  const [toEmail, setToEmail] = useState<string>(inferRecipient(ticket));
  const [subject, setSubject] = useState<string>(`Re: ${ticket.title}`);
  const [editedBody, setEditedBody] = useState<string>(draftText);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirmSend() {
    setError(null);
    if (!toEmail.trim() || !/.+@.+\..+/.test(toEmail.trim())) {
      setError("Enter a valid email address before sending.");
      return;
    }
    setSending(true);
    try {
      const res = await fetchWithRefresh(
        `/api/support/tickets/${encodeURIComponent(ticket.id)}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            to_email: toEmail.trim(),
            subject: subject.trim() || `Re: ${ticket.title}`,
            body: editedBody,
          }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(
          errBody.error ??
            "We couldn't send the message. Try again in a moment.",
        );
        return;
      }
      const data = (await res.json()) as
        | SupportTicket
        | { ticket: SupportTicket };
      const fresh =
        data && typeof data === "object" && "ticket" in data
          ? (data as { ticket: SupportTicket }).ticket
          : (data as SupportTicket);
      onSent(fresh);
    } catch (err) {
      setError(
        `Something went wrong sending the message: ${(err as Error).message}`,
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      data-testid="ticket-detail-send-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Send support response"
      onClick={(e) => {
        if (e.target === e.currentTarget && !sending) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: "var(--wp-card, var(--wp-dark-surface))",
          border: "1px solid var(--wp-border, var(--wp-dark-border))",
          borderRadius: 10,
          padding: "1.4rem",
          maxWidth: 640,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        <h2 style={{ margin: "0 0 0.4rem", fontSize: "1.1rem" }}>
          Confirm and send
        </h2>
        <p
          style={{
            margin: "0 0 1rem",
            color: "var(--wp-text-dim)",
            fontSize: "0.85rem",
          }}
        >
          This is exactly what will be sent. Review or edit before
          confirming.
        </p>

        <div
          data-testid="send-modal-from"
          data-audience={audience}
          data-from-address={fromEmail}
          style={{ marginBottom: "0.9rem" }}
        >
          <label
            htmlFor="send-from"
            style={{
              display: "block",
              marginBottom: "0.2rem",
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
            }}
          >
            From
          </label>
          <input
            id="send-from"
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            data-testid="send-modal-from-input"
            disabled={sending}
            placeholder={
              audience === "client"
                ? "support@thewolfpack.agency"
                : "your.address@thewolfpack.agency"
            }
            style={{
              width: "100%",
              padding: "0.5rem 0.7rem",
              background: "var(--wp-dark)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              borderRadius: 6,
              fontSize: "0.9rem",
              boxSizing: "border-box",
            }}
          />
          {/* Mirror the address as visible text too so screen readers
              + tests that read .textContent see the resolved address.
              Plays well with the editable input above — operators see
              the canonical version under the field while editing. */}
          <p
            data-testid="send-modal-from-resolved"
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.78rem",
              color: "var(--wp-text-dim)",
            }}
          >
            Sending from {fromEmail || "(no address)"}.
          </p>
        </div>

        <div style={{ marginBottom: "0.9rem" }}>
          <label
            htmlFor="send-to"
            style={{
              display: "block",
              marginBottom: "0.2rem",
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
            }}
          >
            To
          </label>
          <input
            id="send-to"
            type="email"
            value={toEmail}
            onChange={(e) => setToEmail(e.target.value)}
            data-testid="send-modal-to"
            disabled={sending}
            placeholder="user@example.com"
            style={{
              width: "100%",
              padding: "0.5rem 0.7rem",
              background: "var(--wp-dark)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              borderRadius: 6,
              fontSize: "0.9rem",
              boxSizing: "border-box",
            }}
          />
        </div>

        <div style={{ marginBottom: "0.9rem" }}>
          <label
            htmlFor="send-subject"
            style={{
              display: "block",
              marginBottom: "0.2rem",
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
            }}
          >
            Subject
          </label>
          <input
            id="send-subject"
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            data-testid="send-modal-subject"
            disabled={sending}
            style={{
              width: "100%",
              padding: "0.5rem 0.7rem",
              background: "var(--wp-dark)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              borderRadius: 6,
              fontSize: "0.9rem",
              boxSizing: "border-box",
            }}
          />
        </div>

        <div style={{ marginBottom: "0.9rem" }}>
          <label
            htmlFor="send-body"
            style={{
              display: "block",
              marginBottom: "0.2rem",
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
            }}
          >
            Message
          </label>
          <textarea
            id="send-body"
            value={editedBody}
            onChange={(e) => setEditedBody(e.target.value)}
            data-testid="send-modal-body"
            disabled={sending}
            rows={10}
            style={{
              width: "100%",
              padding: "0.6rem 0.8rem",
              background: "var(--wp-dark)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              borderRadius: 6,
              fontSize: "0.9rem",
              lineHeight: 1.5,
              fontFamily: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
        </div>

        {error && (
          <p
            role="alert"
            data-testid="send-modal-error"
            style={{
              margin: "0 0 0.7rem",
              fontSize: "0.85rem",
              color: "rgb(232,123,123)",
            }}
          >
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            gap: "0.6rem",
            justifyContent: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            data-testid="send-modal-cancel"
            style={{
              background: "transparent",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: "0.88rem",
              cursor: sending ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmSend}
            disabled={sending}
            data-testid="send-modal-confirm"
            style={{
              background: sending
                ? "var(--wp-border, var(--wp-dark-border))"
                : "var(--wp-gold)",
              color: sending ? "var(--wp-text-dim)" : "var(--wp-dark)",
              border: "none",
              padding: "0.55rem 1.1rem",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: "0.88rem",
              cursor: sending ? "not-allowed" : "pointer",
            }}
          >
            {sending
              ? "Sending…"
              : `Send to ${toEmail.trim() || "user"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sent panel + feedback widget                                        */
/* ------------------------------------------------------------------ */

function SentPanel({
  ticket,
  onTicketUpdated,
}: {
  ticket: SupportTicket;
  onTicketUpdated: (next: SupportTicket) => void;
}) {
  return (
    <>
      <section
        data-testid="ticket-detail-sent"
        style={{
          background: "var(--wp-card, var(--wp-dark-surface))",
          border: "1px solid var(--wp-border, var(--wp-dark-border))",
          borderLeft: "4px solid rgb(120,210,150)",
          borderRadius: 8,
          padding: "1.1rem 1.2rem",
          marginBottom: "1.2rem",
        }}
      >
        <header style={{ marginBottom: "0.6rem" }}>
          <h2
            style={{
              margin: 0,
              fontSize: "0.92rem",
              color: "var(--wp-text-dim)",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Response sent
          </h2>
          <p
            style={{
              margin: "0.3rem 0 0",
              fontSize: "0.85rem",
              color: "var(--wp-text)",
            }}
            data-testid="ticket-detail-sent-meta"
          >
            Sent
            {ticket.sent_to ? ` to ${ticket.sent_to}` : ""}
            {ticket.sent_at ? ` at ${formatDateTime(ticket.sent_at)}` : ""}
          </p>
        </header>
        <pre
          data-testid="ticket-detail-sent-body"
          style={{
            margin: 0,
            padding: "0.8rem 0.9rem",
            background: "var(--wp-dark)",
            border: "1px solid var(--wp-border, var(--wp-dark-border))",
            borderRadius: 6,
            color: "var(--wp-text)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "inherit",
            fontSize: "0.9rem",
            lineHeight: 1.5,
          }}
        >
          {ticket.sent_response ?? ""}
        </pre>
      </section>
      <FeedbackWidget
        ticket={ticket}
        onTicketUpdated={onTicketUpdated}
      />
    </>
  );
}

function FeedbackWidget({
  ticket,
  onTicketUpdated,
}: {
  ticket: SupportTicket;
  onTicketUpdated: (next: SupportTicket) => void;
}) {
  const alreadyRated = typeof ticket.feedback_helpful === "boolean";
  const [pendingChoice, setPendingChoice] = useState<null | boolean>(null);
  const [notes, setNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitFeedback(helpful: boolean, notesValue?: string) {
    setError(null);
    setSubmitting(true);
    try {
      const editDiff =
        ticket.draft_response !== undefined &&
        ticket.draft_response !== null &&
        ticket.sent_response !== undefined &&
        ticket.sent_response !== null
          ? {
              original: ticket.draft_response,
              edited: ticket.sent_response,
            }
          : undefined;
      const res = await fetchWithRefresh(
        `/api/support/tickets/${encodeURIComponent(ticket.id)}/feedback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            helpful,
            edit_diff: editDiff,
            notes: notesValue?.trim() ? notesValue.trim() : undefined,
          }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(
          errBody.error ??
            "We couldn't save your feedback. Try again in a moment.",
        );
        return;
      }
      const fresh = (await res.json()) as SupportTicket;
      onTicketUpdated(fresh);
      setPendingChoice(null);
      setNotes("");
    } catch (err) {
      setError(
        `Something went wrong saving feedback: ${(err as Error).message}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (alreadyRated) {
    return (
      <section
        data-testid="ticket-detail-feedback-recorded"
        style={{
          background: "var(--wp-card, var(--wp-dark-surface))",
          border: "1px solid var(--wp-border, var(--wp-dark-border))",
          borderRadius: 8,
          padding: "1rem 1.2rem",
        }}
      >
        <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--wp-text)" }}>
          {ticket.feedback_helpful
            ? "You marked this response as helpful. Thanks for the feedback."
            : "You marked this response as not helpful. We'll learn from it."}
        </p>
        {ticket.feedback_notes && (
          <p
            style={{
              margin: "0.4rem 0 0",
              fontSize: "0.82rem",
              color: "var(--wp-text-dim)",
            }}
          >
            Your notes: {ticket.feedback_notes}
          </p>
        )}
      </section>
    );
  }

  return (
    <section
      data-testid="ticket-detail-feedback"
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        padding: "1rem 1.2rem",
      }}
    >
      <h2
        style={{
          margin: "0 0 0.6rem",
          fontSize: "0.95rem",
          color: "var(--wp-text)",
          fontWeight: 600,
        }}
      >
        Was this response helpful?
      </h2>

      {pendingChoice === null && (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => submitFeedback(true)}
            disabled={submitting}
            data-testid="ticket-detail-feedback-yes"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              border: "none",
              padding: "0.55rem 1.1rem",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: "0.88rem",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            Yes, it helped
          </button>
          <button
            type="button"
            onClick={() => setPendingChoice(false)}
            disabled={submitting}
            data-testid="ticket-detail-feedback-no"
            style={{
              background: "transparent",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              padding: "0.55rem 1.1rem",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: "0.88rem",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            No, it didn&apos;t
          </button>
        </div>
      )}

      {pendingChoice === false && (
        <div data-testid="ticket-detail-feedback-no-form">
          <label
            htmlFor="feedback-notes"
            style={{
              display: "block",
              marginBottom: "0.3rem",
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
            }}
          >
            What was missing or wrong? (optional)
          </label>
          <textarea
            id="feedback-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            data-testid="ticket-detail-feedback-notes"
            disabled={submitting}
            style={{
              width: "100%",
              padding: "0.6rem 0.8rem",
              background: "var(--wp-dark)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              borderRadius: 6,
              fontSize: "0.9rem",
              fontFamily: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              marginTop: "0.6rem",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={() => submitFeedback(false, notes)}
              disabled={submitting}
              data-testid="ticket-detail-feedback-submit"
              style={{
                background: "var(--wp-gold)",
                color: "var(--wp-dark)",
                border: "none",
                padding: "0.55rem 1.1rem",
                borderRadius: 6,
                fontWeight: 600,
                fontSize: "0.88rem",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "Saving…" : "Submit feedback"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingChoice(null);
                setNotes("");
              }}
              disabled={submitting}
              data-testid="ticket-detail-feedback-cancel"
              style={{
                background: "transparent",
                color: "var(--wp-text)",
                border: "1px solid var(--wp-border, var(--wp-dark-border))",
                padding: "0.55rem 1rem",
                borderRadius: 6,
                fontWeight: 600,
                fontSize: "0.88rem",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p
          role="alert"
          data-testid="ticket-detail-feedback-error"
          style={{
            margin: "0.6rem 0 0",
            fontSize: "0.85rem",
            color: "rgb(232,123,123)",
          }}
        >
          {error}
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Category chip + change-category picker                              */
/* ------------------------------------------------------------------ */

/**
 * Header chip that shows the ticket's category and exposes a small
 * "Change" picker so the operator can correct the AI's pick. When the
 * category was set by the AI, the chip also shows the source ('AI')
 * and confidence so the operator knows whether to second-guess it.
 *
 * Persistence: PATCH /api/support/tickets/[id] with `{ category }`.
 * The route already accepts `category` in PATCHABLE_FIELDS so we don't
 * need a new endpoint. On success the parent's onTicketUpdated swaps
 * in the fresh ticket and the chip re-renders with the new label.
 */
function CategoryChip({
  ticket,
  onTicketUpdated,
}: {
  ticket: SupportTicket;
  onTicketUpdated: (next: SupportTicket) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = ticket.category_source ?? "manual";
  const confidence =
    typeof ticket.category_confidence === "number"
      ? ticket.category_confidence
      : null;
  const cat = categoryOf(ticket);

  async function chooseCategory(next: TicketCategory) {
    if (next === cat) {
      setPicking(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/support/tickets/${encodeURIComponent(ticket.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category: next }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(
          errBody.error ??
            "We couldn't update the category. Try again in a moment.",
        );
        return;
      }
      const json = (await res.json()) as { ticket?: SupportTicket };
      const fresh = json.ticket ?? {
        ...ticket,
        category: next,
        category_source: "manual" as const,
      };
      onTicketUpdated(fresh);
      setPicking(false);
    } catch (err) {
      setError(
        `Something went wrong updating the category: ${(err as Error).message}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <span
      data-testid="ticket-detail-category-chip"
      data-category={cat}
      data-category-source={source}
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.35rem",
        fontSize: "0.78rem",
        color: "var(--wp-text-dim)",
      }}
    >
      <span>{CATEGORY_LABEL[cat]}</span>
      {source === "ai" && (
        <span
          data-testid="ticket-detail-category-source"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.2rem",
            padding: "0.1rem 0.4rem",
            borderRadius: 999,
            background: "rgba(120,180,232,0.15)",
            color: "rgb(120,180,232)",
            fontWeight: 600,
          }}
        >
          AI
          {confidence !== null && (
            <span
              data-testid="ticket-detail-category-confidence"
              style={{ fontWeight: 500, opacity: 0.85 }}
            >
              {Math.round(confidence * 100)}%
            </span>
          )}
        </span>
      )}
      {!picking && (
        <button
          type="button"
          onClick={() => setPicking(true)}
          disabled={saving}
          data-testid="ticket-detail-category-change"
          style={{
            background: "transparent",
            border: "1px solid var(--wp-border, var(--wp-dark-border))",
            color: "var(--wp-text-dim)",
            borderRadius: 999,
            padding: "0.1rem 0.5rem",
            fontSize: "0.72rem",
            fontWeight: 600,
            cursor: saving ? "not-allowed" : "pointer",
          }}
        >
          Change
        </button>
      )}
      {picking && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
          }}
        >
          <select
            data-testid="ticket-detail-category-select"
            disabled={saving}
            defaultValue={cat}
            onChange={(e) => chooseCategory(e.target.value as TicketCategory)}
            style={{
              background: "var(--wp-dark)",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              borderRadius: 6,
              padding: "0.2rem 0.4rem",
              fontSize: "0.78rem",
            }}
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {CATEGORY_LABEL[opt]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setPicking(false);
              setError(null);
            }}
            disabled={saving}
            data-testid="ticket-detail-category-cancel"
            style={{
              background: "transparent",
              border: "1px solid var(--wp-border, var(--wp-dark-border))",
              color: "var(--wp-text-dim)",
              borderRadius: 999,
              padding: "0.1rem 0.5rem",
              fontSize: "0.72rem",
              fontWeight: 600,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
        </span>
      )}
      {error && (
        <span
          role="alert"
          data-testid="ticket-detail-category-error"
          style={{
            color: "rgb(232,123,123)",
            fontSize: "0.72rem",
          }}
        >
          {error}
        </span>
      )}
    </span>
  );
}
