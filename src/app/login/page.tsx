"use client";

import { useState, FormEvent, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setInstinctSession, authHeaders, fetchWithRefresh } from "@/lib/client-auth";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [msLoading, setMsLoading] = useState(false);

  /* Surface a banner when the MS sign-in callback redirected back here
     with a denial / error (domain not allowed, profile fetch failed,
     etc.). The query param is cleared so a refresh doesn't re-show. */
  useEffect(() => {
    const ms = searchParams?.get("ms_signin");
    if (!ms) return;
    const detail = searchParams?.get("detail") ?? "";
    if (ms === "denied" && detail === "domain_not_allowed") {
      setError(
        "That Microsoft account isn't on the @thewolfpack.agency domain. Use your work email.",
      );
    } else if (ms === "error") {
      setError(
        `Microsoft sign-in failed${detail ? `: ${detail}` : ""}. Try again or use the password form.`,
      );
    }
  }, [searchParams]);

  async function handleMicrosoftSignIn() {
    setError("");
    setMsLoading(true);
    try {
      const res = await fetch("/api/auth/microsoft-start");
      if (!res.ok) {
        setError(
          "Microsoft sign-in is unavailable right now. Use the password form.",
        );
        setMsLoading(false);
        return;
      }
      const { authUrl } = (await res.json()) as { authUrl?: string };
      if (!authUrl) {
        setError("Microsoft sign-in is misconfigured. Use the password form.");
        setMsLoading(false);
        return;
      }
      window.location.assign(authUrl);
    } catch {
      setError("Network error. Try the password form.");
      setMsLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetchWithRefresh("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Login failed");
        setLoading(false);
        return;
      }

      setInstinctSession(data.token, data.user);

      // Track page view
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ event: "system.login", metadata: { page: "login" } }),
      }).catch(() => {});

      router.push("/");
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div
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
          <img
            src="/wolfpack-logo.png"
            alt="Wolfpack"
            className="h-16 w-auto mb-4"
          />
          <h1
            className="text-3xl font-bold"
            style={{ color: "var(--wp-gold)" }}
          >
            Instinct
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
            Team Intelligence Platform
          </p>
        </div>

        <button
          type="button"
          data-testid="microsoft-signin-button"
          onClick={() => void handleMicrosoftSignIn()}
          disabled={msLoading || loading}
          className="w-full rounded-lg py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 mb-4 flex items-center justify-center gap-2"
          style={{
            background: "var(--wp-dark-surface2)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-gold)",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden>
            <rect x="0" y="0" width="11" height="11" fill="#f25022" />
            <rect x="12" y="0" width="11" height="11" fill="#7fba00" />
            <rect x="0" y="12" width="11" height="11" fill="#00a4ef" />
            <rect x="12" y="12" width="11" height="11" fill="#ffb900" />
          </svg>
          {msLoading ? "Redirecting…" : "Sign in with Microsoft"}
        </button>

        <div
          className="text-xs text-center mb-4"
          style={{ color: "var(--wp-text-muted)" }}
        >
          or use email + password
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
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
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
              placeholder="you@wolfpack.dev"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium mb-1.5"
              style={{ color: "var(--wp-text-dim)" }}
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
              placeholder="Enter password"
            />
          </div>

          {error && (
            <div
              className="rounded-lg px-4 py-2.5 text-sm"
              style={{ background: "rgba(239, 68, 68, 0.1)", color: "var(--wp-error)" }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg py-2.5 text-sm font-semibold transition-colors disabled:opacity-50"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
            }}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div
          className="mt-6 rounded-lg px-4 py-3 text-xs text-center"
          style={{
            background: "var(--wp-dark-surface2)",
            color: "var(--wp-text-muted)",
          }}
        >
          <p className="font-medium mb-1" style={{ color: "var(--wp-text-dim)" }}>
            Demo Credentials
          </p>
          <p>ceo@wolfpack.dev / apex</p>
          <p>cto@wolfpack.dev / apex</p>
          <p>dev@wolfpack.dev / apex</p>
          <p>sales@wolfpack.dev / apex</p>
          <p>ops@wolfpack.dev / apex</p>
        </div>
      </div>
    </div>
  );
}
