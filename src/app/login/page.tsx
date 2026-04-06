"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
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

      localStorage.setItem("apex_token", data.token);
      localStorage.setItem("apex_user", JSON.stringify(data.user));

      // Track page view
      fetch("/api/analytics", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${data.token}`,
        },
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
            Apex
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
            Team Intelligence Platform
          </p>
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
