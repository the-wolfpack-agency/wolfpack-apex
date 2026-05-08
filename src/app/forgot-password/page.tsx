"use client";

/**
 * /forgot-password — public "send me a reset link" page.
 *
 * On submit, POSTs to /api/auth/forgot-password and shows a generic
 * success message regardless of whether the email exists (the route
 * also returns the same shape, but the UI mirrors the contract so a
 * future server-side change can't accidentally leak existence).
 *
 * When the API returns dev_link (email-not-delivered fallback used
 * before RESEND_API_KEY is wired), surface it directly so the CTO
 * can hand-deliver the link.
 */

import { useState, FormEvent } from "react";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.includes("@")) {
      setError("Enter a valid email.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        dev_link?: string;
        error?: string;
      };
      if (res.status === 429) {
        setError(data.error || "Too many attempts. Try again later.");
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        setError(data.error || "Could not send reset link.");
        setSubmitting(false);
        return;
      }
      if (data.dev_link) setDevLink(data.dev_link);
      setDone(true);
      setSubmitting(false);
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="forgot-password-page"
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--wp-dark)" }}
    >
      <div
        className="w-full max-w-md rounded-xl border p-8"
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
        }}
      >
        <div className="flex flex-col items-center mb-8 text-center">
          <h1 className="text-3xl font-bold" style={{ color: "var(--wp-gold)" }}>
            Reset password
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
            Enter your email and we&apos;ll send a link to set a new password.
          </p>
        </div>

        {done ? (
          <div className="space-y-4" data-testid="forgot-password-success">
            <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
              If an account exists for that email, a reset link is on its way.
              The link expires in 15 minutes.
            </p>
            {devLink && (
              <div
                className="rounded-lg p-3 text-xs break-all border"
                data-testid="forgot-password-dev-link"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text-dim)",
                  fontFamily: "var(--font-mono, monospace)",
                }}
              >
                <p className="font-sans mb-2" style={{ color: "var(--wp-warning)", fontFamily: "inherit" }}>
                  Email delivery not configured. Hand this link to the requester:
                </p>
                {devLink}
              </div>
            )}
            <a
              href="/login"
              data-testid="forgot-password-back-to-login"
              className="block text-center rounded-lg px-4 py-2.5 font-medium transition-colors"
              style={{
                background: "var(--wp-gold)",
                color: "var(--wp-dark)",
                textDecoration: "none",
              }}
            >
              Back to sign in
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5" data-testid="forgot-password-form">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium mb-1.5"
                style={{ color: "var(--wp-text-dim)" }}
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                data-testid="forgot-password-email"
                className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
                placeholder="you@thewolfpack.agency"
              />
            </div>

            {error && (
              <div
                data-testid="forgot-password-error"
                className="rounded-lg px-4 py-2.5 text-sm"
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  color: "var(--wp-error)",
                  border: "1px solid var(--wp-error)",
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              data-testid="forgot-password-submit"
              className="w-full rounded-lg px-4 py-2.5 font-medium transition-colors"
              style={{
                background: submitting ? "var(--wp-dark-surface2)" : "var(--wp-gold)",
                color: submitting ? "var(--wp-text-muted)" : "var(--wp-dark)",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "Sending…" : "Send reset link"}
            </button>

            <div className="text-center">
              <a
                href="/login"
                data-testid="forgot-password-cancel"
                className="text-xs"
                style={{ color: "var(--wp-text-dim)" }}
              >
                Back to sign in
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
