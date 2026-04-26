"use client";

/**
 * /emails?id=<id> — single-email reading view + inline reply.
 *
 * Renders when the user lands on /emails with an `?id=<id>` query
 * (search results, in-app notifications, etc.). Without this view
 * the deep-link dropped users on a blank compose form which made
 * the search "Emails" surface effectively useless.
 *
 * Behavior:
 *   - GET /api/mail/[id] on mount → { message } or typed error.
 *   - Renders subject, from, received time, body (HTML sanitized
 *     to a safe subset; plain text wrapped in <pre> for line breaks).
 *   - Inline reply textarea + Send button → POST /api/mail/reply
 *     with { originalMessageId, bodyText }. Optimistic disable +
 *     transient success/error banner.
 *   - Error states surface inline:
 *       not_connected   → "Connect Microsoft" CTA → /settings
 *       scope_missing   → "Grant Mail.Read" CTA → /settings
 *       not_found       → "Couldn't find this email" + Back to compose
 *       graph_error/etc → generic "Try again" with retry
 *   - Back button (and on success) clears `?id=` and signals parent
 *     to drop back to compose mode via `onClose`.
 *
 * Auth: every fetch goes through fetchWithRefresh per repo rule.
 * Analytics: emit on view + reply success/failure.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { emitInsight } from "@/lib/insights/emit";

interface RecipientSummary {
  name: string;
  email: string;
}

export interface MessageDetail {
  id: string;
  subject: string;
  from: RecipientSummary;
  toRecipients: RecipientSummary[];
  ccRecipients: RecipientSummary[];
  receivedDateTime: string;
  bodyContentType: "html" | "text";
  bodyContent: string;
  bodyPreview: string;
  webLink: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; message: MessageDetail }
  | {
      kind: "error";
      code: "unauthorized" | "not_connected" | "scope_missing" | "not_found" | "graph_error";
      message?: string;
      scope?: string;
    };

type ReplyState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; reason: "scope_missing" | "rate_limited" | "graph_error" | "network"; message?: string };

interface EmailReaderProps {
  id: string;
  onClose: () => void;
  /** Override hooks for tests; never used in production. */
  _now?: () => number;
}

function formatRelative(iso: string, nowMs: number = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = nowMs - t;
  const m = 60 * 1000;
  const h = 60 * m;
  const d = 24 * h;
  if (diff < m) return "just now";
  if (diff < h) return `${Math.round(diff / m)}m ago`;
  if (diff < d) return `${Math.round(diff / h)}h ago`;
  if (diff < 7 * d) return `${Math.round(diff / d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Strip the body HTML to a safe subset. Outlook bodies arrive as
 * full HTML documents (style tags, scripts, conditional comments).
 * We render the plain-text projection inside a styled container
 * rather than dropping raw HTML into the page — same trade-off the
 * messages page makes for chat HTML, which already shipped.
 */
function htmlToSafeText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function EmailReader({ id, onClose, _now }: EmailReaderProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reply, setReply] = useState<string>("");
  const [replyState, setReplyState] = useState<ReplyState>({ kind: "idle" });

  const loadMessage = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetchWithRefresh(`/api/mail/${encodeURIComponent(id)}`, {
        headers: jsonHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && body?.message) {
        setState({ kind: "ready", message: body.message as MessageDetail });
        emitInsight({
          actor: "self",
          role: "user",
          surface: "email",
          action: "message_viewed",
          tier: "personal",
          payload: { id },
        });
        return;
      }
      if (res.status === 401) {
        setState({
          kind: "error",
          code: body?.error === "microsoft_not_connected" ? "not_connected" : "unauthorized",
        });
        return;
      }
      if (res.status === 403 && body?.code === "scope_missing") {
        setState({ kind: "error", code: "scope_missing", scope: body?.scope ?? "Mail.Read" });
        return;
      }
      if (res.status === 404) {
        setState({ kind: "error", code: "not_found" });
        return;
      }
      setState({
        kind: "error",
        code: "graph_error",
        message: body?.message ?? `request_failed_${res.status}`,
      });
    } catch (err) {
      setState({ kind: "error", code: "graph_error", message: (err as Error).message });
    }
  }, [id]);

  useEffect(() => {
    void loadMessage();
  }, [loadMessage]);

  const sendReply = useCallback(async () => {
    if (state.kind !== "ready") return;
    const trimmed = reply.trim();
    if (!trimmed) return;
    setReplyState({ kind: "sending" });
    try {
      const res = await fetchWithRefresh("/api/mail/reply", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          originalMessageId: state.message.id,
          bodyText: trimmed,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202 || res.status === 200) {
        setReplyState({ kind: "sent" });
        setReply("");
        emitInsight({
          actor: "self",
          role: "user",
          surface: "email",
          action: "reply_sent",
          tier: "personal",
          payload: { id: state.message.id },
        });
        return;
      }
      if (res.status === 403 && body?.code === "scope_missing") {
        setReplyState({ kind: "error", reason: "scope_missing", message: body?.scope ?? "Mail.Send" });
        return;
      }
      if (res.status === 429) {
        setReplyState({
          kind: "error",
          reason: "rate_limited",
          message: `Try again in ${body?.retryAfter ?? 60}s`,
        });
        return;
      }
      setReplyState({
        kind: "error",
        reason: "graph_error",
        message: body?.message ?? `request_failed_${res.status}`,
      });
      emitInsight({
        actor: "self",
        role: "user",
        surface: "email",
        action: "reply_failed",
        tier: "personal",
        payload: { id: state.message.id, status: res.status },
      });
    } catch (err) {
      setReplyState({ kind: "error", reason: "network", message: (err as Error).message });
    }
  }, [reply, state]);

  if (state.kind === "loading") {
    return (
      <div data-testid="email-reader-loading" style={containerStyle}>
        <p style={{ color: "var(--wp-text-dim)" }}>Loading email…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div data-testid="email-reader-error" data-code={state.code} style={containerStyle}>
        <button
          type="button"
          data-testid="email-reader-back"
          onClick={onClose}
          style={backButtonStyle}
        >
          ← Back to compose
        </button>
        {state.code === "not_connected" || state.code === "unauthorized" ? (
          <div style={errorCardStyle}>
            <h3 style={{ margin: "0 0 8px", color: "var(--wp-text)" }}>
              Connect Microsoft 365 to read this email
            </h3>
            <p style={{ color: "var(--wp-text-dim)", marginBottom: 12 }}>
              We couldn&apos;t talk to Microsoft Graph. Connect your account
              and try again.
            </p>
            <Link
              href="/settings"
              data-testid="email-reader-settings-cta"
              style={ctaButtonStyle}
            >
              Open Settings
            </Link>
          </div>
        ) : state.code === "scope_missing" ? (
          <div style={errorCardStyle}>
            <h3 style={{ margin: "0 0 8px", color: "var(--wp-text)" }}>
              Grant {state.scope ?? "Mail.Read"} to read this email
            </h3>
            <p style={{ color: "var(--wp-text-dim)", marginBottom: 12 }}>
              Reading individual messages requires the {state.scope ?? "Mail.Read"}{" "}
              scope on your Microsoft connection.
            </p>
            <Link
              href="/settings"
              data-testid="email-reader-settings-cta"
              style={ctaButtonStyle}
            >
              Open Settings
            </Link>
          </div>
        ) : state.code === "not_found" ? (
          <div style={errorCardStyle}>
            <h3 style={{ margin: "0 0 8px", color: "var(--wp-text)" }}>
              Couldn&apos;t find that email
            </h3>
            <p style={{ color: "var(--wp-text-dim)" }}>
              The message may have been moved, deleted, or is not in your
              mailbox. Try searching again.
            </p>
          </div>
        ) : (
          <div style={errorCardStyle}>
            <h3 style={{ margin: "0 0 8px", color: "var(--wp-text)" }}>
              Couldn&apos;t load this email
            </h3>
            <p style={{ color: "var(--wp-text-dim)", marginBottom: 12 }}>
              {state.message ?? "Something went wrong talking to Microsoft."}
            </p>
            <button
              type="button"
              data-testid="email-reader-retry"
              onClick={() => void loadMessage()}
              style={ctaButtonStyle}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const m = state.message;
  const bodyText =
    m.bodyContentType === "html" ? htmlToSafeText(m.bodyContent) : m.bodyContent;
  const canSend = reply.trim().length > 0 && replyState.kind !== "sending";

  return (
    <div data-testid="email-reader" style={containerStyle}>
      <button
        type="button"
        data-testid="email-reader-back"
        onClick={onClose}
        style={backButtonStyle}
      >
        ← Back to compose
      </button>

      <header style={headerStyle}>
        <h2
          data-testid="email-reader-subject"
          style={{ margin: "0 0 8px", color: "var(--wp-text)", fontSize: "1.2rem" }}
        >
          {m.subject || "(no subject)"}
        </h2>
        <div style={metaRowStyle}>
          <div data-testid="email-reader-from" style={{ color: "var(--wp-text)" }}>
            <strong>{m.from.name || m.from.email}</strong>
            {m.from.email && m.from.name ? (
              <span style={{ color: "var(--wp-text-dim)" }}> &lt;{m.from.email}&gt;</span>
            ) : null}
          </div>
          <span
            data-testid="email-reader-received"
            style={{ color: "var(--wp-text-dim)", fontSize: "0.8rem" }}
          >
            {formatRelative(m.receivedDateTime, _now ? _now() : undefined)}
          </span>
        </div>
        {m.toRecipients.length > 0 ? (
          <div style={{ color: "var(--wp-text-dim)", fontSize: "0.8rem", marginTop: 4 }}>
            To: {m.toRecipients.map((r) => r.name || r.email).join(", ")}
          </div>
        ) : null}
        {m.ccRecipients.length > 0 ? (
          <div style={{ color: "var(--wp-text-dim)", fontSize: "0.8rem" }}>
            Cc: {m.ccRecipients.map((r) => r.name || r.email).join(", ")}
          </div>
        ) : null}
      </header>

      <article
        data-testid="email-reader-body"
        style={{
          color: "var(--wp-text)",
          background: "var(--wp-surface)",
          padding: 16,
          borderRadius: 8,
          border: "1px solid var(--wp-border)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
          lineHeight: 1.5,
          fontSize: 14,
          margin: "12px 0 16px",
        }}
      >
        {bodyText || m.bodyPreview || "(no body)"}
      </article>

      <section
        data-testid="email-reader-reply"
        style={{
          background: "var(--wp-surface)",
          border: "1px solid var(--wp-border)",
          borderRadius: 8,
          padding: 12,
        }}
      >
        <label
          htmlFor="email-reader-reply-input"
          style={{
            display: "block",
            color: "var(--wp-text)",
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 6,
          }}
        >
          Reply to {m.from.name || m.from.email}
        </label>
        <textarea
          id="email-reader-reply-input"
          data-testid="email-reader-reply-input"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Write your reply…"
          rows={4}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            padding: 10,
            borderRadius: 6,
            border: "1px solid var(--wp-border)",
            background: "var(--wp-surface)",
            color: "var(--wp-text)",
            fontSize: 14,
            fontFamily: "inherit",
            lineHeight: 1.4,
          }}
        />
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 8,
          }}
        >
          <span
            data-testid="email-reader-reply-status"
            style={{ fontSize: 12, color: "var(--wp-text-dim)" }}
          >
            {replyState.kind === "sending"
              ? "Sending…"
              : replyState.kind === "sent"
                ? "Reply sent ✓"
                : replyState.kind === "error"
                  ? `Couldn't send: ${replyState.reason}${replyState.message ? ` — ${replyState.message}` : ""}`
                  : ""}
          </span>
          <button
            type="button"
            data-testid="email-reader-reply-send"
            onClick={() => void sendReply()}
            disabled={!canSend}
            style={{
              ...ctaButtonStyle,
              opacity: canSend ? 1 : 0.5,
              cursor: canSend ? "pointer" : "not-allowed",
            }}
          >
            {replyState.kind === "sending" ? "Sending…" : "Send reply"}
          </button>
        </div>
        {replyState.kind === "error" && replyState.reason === "scope_missing" ? (
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--wp-text-dim)" }}>
            Replies need the <code>{replyState.message ?? "Mail.Send"}</code> scope.{" "}
            <Link href="/settings" style={{ color: "var(--wp-gold)" }}>
              Open settings
            </Link>{" "}
            to grant it.
          </p>
        ) : null}
      </section>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 800,
  margin: "0 auto",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  // Lock to the parent's width — long unbroken tokens (URLs, etc.)
  // must wrap inside the reader rather than push the page sideways
  // on mobile.
  boxSizing: "border-box",
  minWidth: 0,
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const headerStyle: React.CSSProperties = {
  borderBottom: "1px solid var(--wp-border)",
  paddingBottom: 12,
  minWidth: 0,
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const metaRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "baseline",
  flexWrap: "wrap",
  minWidth: 0,
};

const backButtonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "1px solid var(--wp-border)",
  color: "var(--wp-text)",
  padding: "6px 12px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};

const ctaButtonStyle: React.CSSProperties = {
  display: "inline-block",
  background: "var(--wp-gold)",
  color: "var(--wp-dark-surface, #1a1a1a)",
  padding: "8px 16px",
  borderRadius: 6,
  border: "none",
  textDecoration: "none",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const errorCardStyle: React.CSSProperties = {
  background: "var(--wp-surface)",
  border: "1px solid var(--wp-border)",
  borderRadius: 8,
  padding: 16,
};
