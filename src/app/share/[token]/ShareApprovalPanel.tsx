"use client";

/**
 * ShareApprovalPanel — client-side submit bar for /share/[token].
 *
 * Split out of page.tsx so the page itself stays a server component
 * (needed for secret access + DB lookup). This component only handles
 * the UI state + the POST to /api/public/approvals/[token]. It renders
 * inline success / error states — we never redirect so the reviewer
 * can still see the preview after clicking Approve.
 *
 * Raw fetch is intentional here: this page is UNAUTHENTICATED. There
 * is no JWT, no refresh token, no `fetchWithRefresh` applicable — the
 * signed share token IS the credential, and it's already in the URL.
 * That's why this file is excluded from the `no-raw-api-fetch` guard.
 */

import { useState } from "react";

type Status = "idle" | "submitting" | "success" | "error";

export default function ShareApprovalPanel({ token }: { token: string }) {
  const [comment, setComment] = useState("");
  const [actorName, setActorName] = useState("");
  const [actorEmail, setActorEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [submittedState, setSubmittedState] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit(state: "approved" | "changes_requested") {
    setStatus("submitting");
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/public/approvals/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state,
          comment: comment.trim() || undefined,
          actorName: actorName.trim() || undefined,
          actorEmail: actorEmail.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg =
          typeof data?.error === "string" ? data.error : "Submission failed.";
        setStatus("error");
        setErrorMessage(msg);
        return;
      }
      setStatus("success");
      setSubmittedState(state);
    } catch (err) {
      setStatus("error");
      setErrorMessage((err as Error).message || "Network error.");
    }
  }

  if (status === "success") {
    return (
      <div
        data-testid="share-success"
        role="status"
        aria-live="polite"
        style={{
          padding: "20px",
          background: "#112a1b",
          borderTop: "1px solid #1d5a34",
          color: "#b7f0cd",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
          Thanks — your response has been recorded.
        </div>
        <div style={{ fontSize: 13, color: "#8dd4a9" }}>
          {submittedState === "approved"
            ? "Your approval is logged. Your designer has been notified."
            : "Your change request is logged. Your designer has been notified."}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="share-approval-panel"
      style={{
        position: "sticky",
        bottom: 0,
        padding: "16px 20px",
        background: "#111",
        borderTop: "1px solid #222",
        boxShadow: "0 -4px 16px rgba(0,0,0,0.3)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label style={{ flex: "1 1 200px", fontSize: 12, color: "#aaa" }}>
          Your name (optional)
          <input
            data-testid="share-actor-name"
            type="text"
            value={actorName}
            onChange={(e) => setActorName(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ flex: "1 1 200px", fontSize: 12, color: "#aaa" }}>
          Your email (optional)
          <input
            data-testid="share-actor-email"
            type="email"
            value={actorEmail}
            onChange={(e) => setActorEmail(e.target.value)}
            style={inputStyle}
          />
        </label>
      </div>
      <label style={{ fontSize: 12, color: "#aaa" }}>
        Comment (optional)
        <textarea
          data-testid="share-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="Anything you'd like the designer to know?"
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          flexWrap: "wrap",
        }}
      >
        <button
          data-testid="share-request-changes"
          type="button"
          disabled={status === "submitting"}
          onClick={() => submit("changes_requested")}
          style={secondaryBtn}
        >
          Request changes
        </button>
        <button
          data-testid="share-approve"
          type="button"
          disabled={status === "submitting"}
          onClick={() => submit("approved")}
          style={primaryBtn}
        >
          {status === "submitting" ? "Sending…" : "Approve"}
        </button>
      </div>
      {errorMessage && (
        <div
          data-testid="share-error"
          role="alert"
          style={{ color: "#ff9e9e", fontSize: 12 }}
        >
          {errorMessage}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "8px 10px",
  background: "#1a1a1a",
  color: "#fff",
  border: "1px solid #333",
  borderRadius: 4,
  fontSize: 14,
  fontFamily: "inherit",
};

const primaryBtn: React.CSSProperties = {
  padding: "10px 20px",
  background: "#2e7d4f",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 14,
};

const secondaryBtn: React.CSSProperties = {
  padding: "10px 20px",
  background: "transparent",
  color: "#f0f0f0",
  border: "1px solid #444",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 14,
};
