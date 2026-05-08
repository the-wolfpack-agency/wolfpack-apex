"use client";

/**
 * /reset-password — public "set new password" page driven by token.
 *
 * Reads `?token=...` from the URL, posts to /api/auth/reset-password
 * with the token + new password, redirects to /login on success.
 *
 * Wrapped in <Suspense> so useSearchParams doesn't fail Next.js's
 * static prerender check (same pattern as /accept-invite).
 */

import { Suspense, useEffect, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params?.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Missing reset token. Request a new link from /forgot-password.");
    }
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!token) {
      setError("Missing reset token.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not reset password. The link may be expired or already used.");
        setSubmitting(false);
        return;
      }
      router.push("/login?reset=1");
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="reset-password-page"
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
            Choose a new password
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
            Pick something at least 8 characters long.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5" data-testid="reset-password-form">
          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text-dim)" }}>
              New password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              data-testid="reset-password-input"
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
              placeholder="At least 8 characters"
            />
          </div>

          <div>
            <label htmlFor="confirm" className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text-dim)" }}>
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              data-testid="reset-password-confirm"
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
              placeholder="Re-enter your password"
            />
          </div>

          {error && (
            <div
              data-testid="reset-password-error"
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
            disabled={submitting || !token}
            data-testid="reset-password-submit"
            className="w-full rounded-lg px-4 py-2.5 font-medium transition-colors"
            style={{
              background: submitting || !token ? "var(--wp-dark-surface2)" : "var(--wp-gold)",
              color: submitting || !token ? "var(--wp-text-muted)" : "var(--wp-dark)",
              cursor: submitting || !token ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Saving…" : "Save new password"}
          </button>
        </form>
      </div>
    </div>
  );
}
