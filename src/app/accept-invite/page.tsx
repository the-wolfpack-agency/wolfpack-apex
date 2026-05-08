"use client";

/**
 * /accept-invite — public page where invitees set their password.
 *
 * Reads `?token=...` from the query, posts to /api/team/accept with the
 * token + a password, and redirects to /login on success with a flag so
 * the login page can show "Account ready, sign in to continue".
 *
 * No session needed — identity is proven by the single-use signed
 * token on the URL.
 */

import { useEffect, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

export default function AcceptInvitePage() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params?.get("token") ?? "";

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Missing invite token. Ask your inviter for the correct link.");
    }
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!token) {
      setError("Missing invite token.");
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
      const res = await fetch("/api/team/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, name: name || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not accept invite. The link may be expired or already used.");
        setSubmitting(false);
        return;
      }
      router.push("/login?invited=1");
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="accept-invite-page"
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
        <div className="flex flex-col items-center mb-8">
          <h1 className="text-3xl font-bold" style={{ color: "var(--wp-gold)" }}>
            Welcome to Instinct
          </h1>
          <p className="text-sm mt-1 text-center" style={{ color: "var(--wp-text-dim)" }}>
            Set your password to finish creating your account.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5" data-testid="accept-invite-form">
          <div>
            <label htmlFor="name" className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text-dim)" }}>
              Display name (optional)
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
              placeholder="How your name shows in Instinct"
              maxLength={120}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text-dim)" }}>
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
              placeholder="At least 8 characters"
              data-testid="accept-invite-password"
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
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
              placeholder="Re-enter your password"
              data-testid="accept-invite-confirm"
            />
          </div>

          {error && (
            <div
              data-testid="accept-invite-error"
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
            data-testid="accept-invite-submit"
            className="w-full rounded-lg px-4 py-2.5 font-medium transition-colors"
            style={{
              background: submitting || !token ? "var(--wp-dark-surface2)" : "var(--wp-gold)",
              color: submitting || !token ? "var(--wp-text-muted)" : "var(--wp-dark)",
              cursor: submitting || !token ? "not-allowed" : "pointer",
            }}
          >
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
