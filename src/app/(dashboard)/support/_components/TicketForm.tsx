"use client";

/**
 * TicketForm — controlled form for creating a new support ticket.
 *
 * Required fields: title, body. Optional: diagnostic_text, category,
 * severity. The submit button is "Create + Generate AI draft" because
 * POST /api/support/tickets returns the ticket WITH the AI draft
 * pre-populated — that single round-trip can take 5-10s, so we render
 * a clear "Drafting your response…" loading state so the operator
 * doesn't think the page is hung.
 *
 * On success the parent navigates to /support/[id]; this component
 * never owns navigation, it only owns the form + the API call.
 */

import { useState, type FormEvent } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import {
  SEVERITY_DESCRIPTION,
  SEVERITY_LABEL,
  type Severity,
} from "./SeverityBadge";
import type { SupportTicket, TicketCategory } from "./TicketList";

const CATEGORY_OPTIONS: { value: TicketCategory; label: string }[] = [
  { value: "general", label: "General" },
  { value: "m365", label: "Microsoft 365" },
  { value: "azure", label: "Azure" },
  { value: "instinct", label: "Instinct" },
  { value: "wolfpack-auto", label: "Wolfpack Auto" },
];

const SEVERITY_ORDER: Severity[] = ["p0", "p1", "p2", "p3"];

export interface TicketFormProps {
  onCreated: (ticket: SupportTicket) => void;
}

export default function TicketForm({ onCreated }: TicketFormProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [diagnosticText, setDiagnosticText] = useState("");
  const [category, setCategory] = useState<TicketCategory>("general");
  const [severity, setSeverity] = useState<Severity>("p2");
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);
    setServerError(null);

    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();

    if (!trimmedTitle) {
      setValidationError("Add a short title before creating the ticket.");
      return;
    }
    if (!trimmedBody) {
      setValidationError("Describe what's happening so we can draft a response.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetchWithRefresh("/api/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: trimmedTitle,
          body: trimmedBody,
          diagnostic_text: diagnosticText.trim() || undefined,
          category,
          severity,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setServerError(
          errBody.error ??
            "We couldn't create the ticket. Try again in a moment.",
        );
        return;
      }
      const ticket = (await res.json()) as SupportTicket;
      onCreated(ticket);
    } catch (err) {
      setServerError(
        `Something went wrong creating the ticket: ${(err as Error).message}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle = {
    width: "100%",
    padding: "0.55rem 0.75rem",
    background: "var(--wp-dark)",
    color: "var(--wp-text)",
    border: "1px solid var(--wp-border, var(--wp-dark-border))",
    borderRadius: 6,
    fontSize: "0.92rem",
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
  };

  const labelStyle = {
    display: "block",
    marginBottom: "0.25rem",
    color: "var(--wp-text)",
    fontSize: "0.88rem",
    fontWeight: 500,
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="ticket-form"
      style={{
        background: "var(--wp-card, var(--wp-dark-surface))",
        border: "1px solid var(--wp-border, var(--wp-dark-border))",
        borderRadius: 8,
        padding: "1.4rem",
      }}
    >
      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="ticket-title" style={labelStyle}>
          Title <span style={{ color: "rgb(232,123,123)" }}>*</span>
        </label>
        <input
          id="ticket-title"
          type="text"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Short summary of the issue"
          data-testid="ticket-form-title"
          disabled={submitting}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="ticket-body" style={labelStyle}>
          What&apos;s happening?{" "}
          <span style={{ color: "rgb(232,123,123)" }}>*</span>
        </label>
        <textarea
          id="ticket-body"
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Describe the problem in plain language. Who is affected, what they tried, what they expected."
          data-testid="ticket-form-body"
          disabled={submitting}
          rows={6}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label htmlFor="ticket-diagnostic" style={labelStyle}>
          Diagnostic text (optional)
        </label>
        <textarea
          id="ticket-diagnostic"
          value={diagnosticText}
          onChange={(e) => setDiagnosticText(e.target.value)}
          placeholder="Paste any error messages, codes, or logs (e.g. AADSTS20012)"
          data-testid="ticket-form-diagnostic"
          disabled={submitting}
          rows={4}
          style={{
            ...inputStyle,
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.85rem",
            resize: "vertical",
          }}
        />
      </div>

      <div
        style={{
          display: "grid",
          gap: "1rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          marginBottom: "1.2rem",
        }}
      >
        <div>
          <label htmlFor="ticket-category" style={labelStyle}>
            Category
          </label>
          <select
            id="ticket-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as TicketCategory)}
            data-testid="ticket-form-category"
            disabled={submitting}
            style={inputStyle}
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ticket-severity" style={labelStyle}>
            Severity
          </label>
          <select
            id="ticket-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Severity)}
            data-testid="ticket-form-severity"
            disabled={submitting}
            style={inputStyle}
          >
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
          <p
            style={{
              margin: "0.3rem 0 0",
              fontSize: "0.78rem",
              color: "var(--wp-text-dim)",
            }}
          >
            {SEVERITY_DESCRIPTION[severity]}
          </p>
        </div>
      </div>

      {validationError && (
        <p
          role="alert"
          data-testid="ticket-form-validation-error"
          style={{
            margin: "0 0 0.8rem",
            fontSize: "0.85rem",
            color: "rgb(232,123,123)",
          }}
        >
          {validationError}
        </p>
      )}

      {serverError && (
        <p
          role="alert"
          data-testid="ticket-form-server-error"
          style={{
            margin: "0 0 0.8rem",
            fontSize: "0.85rem",
            color: "rgb(232,123,123)",
          }}
        >
          {serverError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        data-testid="ticket-form-submit"
        style={{
          background: submitting
            ? "var(--wp-border, var(--wp-dark-border))"
            : "var(--wp-gold)",
          color: submitting ? "var(--wp-text-dim)" : "var(--wp-dark)",
          border: "none",
          padding: "0.65rem 1.2rem",
          borderRadius: 6,
          fontWeight: 600,
          fontSize: "0.92rem",
          cursor: submitting ? "not-allowed" : "pointer",
        }}
      >
        {submitting ? "Drafting your response…" : "Create + Generate AI draft"}
      </button>

      {submitting && (
        <div
          data-testid="ticket-form-loading-hint"
          style={{
            marginTop: "0.9rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.4rem",
          }}
        >
          <div
            aria-hidden
            style={{
              height: 10,
              borderRadius: 4,
              background:
                "linear-gradient(90deg, rgba(241,194,51,0.10) 0%, rgba(241,194,51,0.30) 50%, rgba(241,194,51,0.10) 100%)",
              backgroundSize: "200% 100%",
              animation: "skeleton-shimmer 1.4s ease-in-out infinite",
            }}
          />
          <div
            aria-hidden
            style={{
              height: 10,
              width: "75%",
              borderRadius: 4,
              background:
                "linear-gradient(90deg, rgba(241,194,51,0.10) 0%, rgba(241,194,51,0.30) 50%, rgba(241,194,51,0.10) 100%)",
              backgroundSize: "200% 100%",
              animation: "skeleton-shimmer 1.4s ease-in-out infinite",
            }}
          />
          <p
            style={{
              margin: 0,
              fontSize: "0.78rem",
              color: "var(--wp-text-dim)",
            }}
          >
            This usually takes 5 to 10 seconds while we look up matching
            playbooks and draft a response.
          </p>
          <style jsx>{`
            @keyframes skeleton-shimmer {
              0% {
                background-position: 200% 0;
              }
              100% {
                background-position: -200% 0;
              }
            }
          `}</style>
        </div>
      )}
    </form>
  );
}
