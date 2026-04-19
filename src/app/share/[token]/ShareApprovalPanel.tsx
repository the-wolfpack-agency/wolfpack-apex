"use client";

/**
 * ShareApprovalPanel — client-side submit bar for /share/[token].
 *
 * Split out of page.tsx so the page itself stays a server component
 * (needed for secret access + DB lookup). This component handles the
 * UI state + the POST to /api/public/approvals/[token]. It renders
 * inline success / error states — we never redirect so the reviewer
 * can still see the preview after clicking Approve.
 *
 * Path C Phase 3 · Stream R3 adds a COMMENT COMPOSER. The preview
 * iframe's overlay emits `comment.pin` postMessages when the reviewer
 * clicks a section; this component listens + renders a composer that
 * POSTs to /api/public/share/[token]/comments on submit.
 *
 * Raw fetch is intentional here: this page is UNAUTHENTICATED. There
 * is no JWT, no refresh token, no `fetchWithRefresh` applicable — the
 * signed share token IS the credential, and it's already in the URL.
 * That's why this file is excluded from the `no-raw-api-fetch` guard.
 */

import { useEffect, useState } from "react";
import {
  INSTINCT_EDIT_ORIGIN,
  isInstinctEditMessage,
} from "@/lib/preview-postmessage";

type Status = "idle" | "submitting" | "success" | "error";
type CommentStatus = "idle" | "submitting" | "posted" | "error";

interface CommentPin {
  pageIndex: number;
  sectionIndex: number;
  clientX: number;
  clientY: number;
}

export default function ShareApprovalPanel({ token }: { token: string }) {
  const [comment, setComment] = useState("");
  const [actorName, setActorName] = useState("");
  const [actorEmail, setActorEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [submittedState, setSubmittedState] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // ---- Section-comment composer state --------------------------------
  const [pin, setPin] = useState<CommentPin | null>(null);
  const [sectionCommentBody, setSectionCommentBody] = useState("");
  const [commentStatus, setCommentStatus] = useState<CommentStatus>("idle");
  const [commentError, setCommentError] = useState<string | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Accept same-origin only — the iframe posts from our own domain.
      if (event.origin !== window.location.origin) return;
      if (!isInstinctEditMessage(event.data)) return;
      if (event.data.type !== "comment.pin") return;
      setPin({
        pageIndex: event.data.pageIndex,
        sectionIndex: event.data.sectionIndex,
        clientX: event.data.clientX,
        clientY: event.data.clientY,
      });
      setSectionCommentBody("");
      setCommentStatus("idle");
      setCommentError(null);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function submitSectionComment() {
    if (!pin) return;
    if (sectionCommentBody.trim().length === 0) {
      setCommentStatus("error");
      setCommentError("Please type a comment before submitting.");
      return;
    }
    setCommentStatus("submitting");
    setCommentError(null);
    try {
      const res = await fetch(
        `/api/public/share/${encodeURIComponent(token)}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pageIndex: pin.pageIndex,
            sectionIndex: pin.sectionIndex,
            body: sectionCommentBody.trim(),
            actorName: actorName.trim() || undefined,
            actorEmail: actorEmail.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCommentStatus("error");
        setCommentError(
          typeof data?.error === "string" ? data.error : "Failed to post comment.",
        );
        return;
      }
      setCommentStatus("posted");
      setSectionCommentBody("");
      // Auto-dismiss after a brief confirmation.
      setTimeout(() => {
        setPin(null);
        setCommentStatus("idle");
      }, 1500);
    } catch (err) {
      setCommentStatus("error");
      setCommentError((err as Error).message || "Network error.");
    }
  }

  function dismissComposer() {
    setPin(null);
    setSectionCommentBody("");
    setCommentStatus("idle");
    setCommentError(null);
  }

  // Expose the origin brand so tests can dispatch matching messages.
  // (unused at runtime — TS dead-import guard needs a reference)
  void INSTINCT_EDIT_ORIGIN;

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
    <>
      {pin && (
        <div
          data-testid="share-comment-composer"
          role="dialog"
          aria-label="Leave a comment on this section"
          style={{
            position: "fixed",
            // Anchor near the click but keep the composer fully on-screen.
            // Clamp by viewport so an edge-of-iframe click doesn't render
            // the dialog off-screen.
            left: Math.min(
              Math.max(pin.clientX, 20),
              (typeof window !== "undefined" ? window.innerWidth : 800) - 340,
            ),
            top: Math.min(
              Math.max(pin.clientY, 20),
              (typeof window !== "undefined" ? window.innerHeight : 600) - 260,
            ),
            width: 320,
            zIndex: 1000,
            padding: 16,
            background: "#1a1a1a",
            border: "1px solid #444",
            borderRadius: 6,
            boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            color: "#f0f0f0",
          }}
        >
          <div style={{ fontSize: 12, color: "#888" }}>
            Comment on section {pin.sectionIndex + 1} (page {pin.pageIndex + 1})
          </div>
          <textarea
            data-testid="share-comment-composer-body"
            value={sectionCommentBody}
            onChange={(e) => setSectionCommentBody(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder="What would you like the designer to know?"
            autoFocus
            style={{ ...inputStyle, resize: "vertical" }}
          />
          {commentStatus === "posted" && (
            <div
              data-testid="share-comment-composer-success"
              role="status"
              aria-live="polite"
              style={{ fontSize: 12, color: "#8dd4a9" }}
            >
              Comment posted.
            </div>
          )}
          {commentStatus === "error" && commentError && (
            <div
              data-testid="share-comment-composer-error"
              role="alert"
              style={{ fontSize: 12, color: "#ff9e9e" }}
            >
              {commentError}
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
            }}
          >
            <button
              data-testid="share-comment-composer-cancel"
              type="button"
              onClick={dismissComposer}
              style={secondaryBtn}
            >
              Cancel
            </button>
            <button
              data-testid="share-comment-composer-submit"
              type="button"
              disabled={commentStatus === "submitting"}
              onClick={submitSectionComment}
              style={primaryBtn}
            >
              {commentStatus === "submitting" ? "Posting…" : "Post comment"}
            </button>
          </div>
        </div>
      )}
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
    </>
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
