"use client";

/**
 * /mfa: where an admin-capable account is sent after signing in when the
 * admin MFA gate requires something of them (src/lib/auth/mfa.ts):
 *
 *   - required = "enroll":    no confirmed enrollment yet. Enroll right here
 *                             (the grace path: nobody is locked out).
 *   - required = "challenge": enrolled. Enter a 6-digit code or a recovery
 *                             code; success sets the 7-day MFA proof cookie.
 *   - required = null:        nothing to do; go to `next`.
 *
 * Outside the (dashboard) group on purpose: every dashboard page calls APIs
 * the gate would refuse, so rendering one first would show a broken page.
 * Unauthenticated visitors are redirected to /login?next=/mfa.
 */

import { useCallback, useEffect, useState, FormEvent } from "react";
import MfaSettingsCard from "@/components/MfaSettingsCard";
import { fetchWithRefresh, getInstinctToken, jsonHeaders } from "@/lib/client-auth";
import { navigateTo, safeNextPath, type MfaRequired } from "@/lib/auth/mfa-client";

export const dynamic = "force-dynamic";

type View = "loading" | "enroll" | "challenge" | "unavailable" | "error";

export default function MfaPage() {
  const [view, setView] = useState<View>("loading");
  const [next, setNext] = useState("/");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goNext = useCallback((target: string) => {
    navigateTo(target);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = safeNextPath(params.get("next"));
    setNext(target);
    if (!getInstinctToken()) {
      navigateTo(`/login?next=${encodeURIComponent("/mfa" + window.location.search)}`);
      return;
    }
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/auth/mfa/status");
        if (!res.ok) {
          setError(`Could not load MFA status (HTTP ${res.status}).`);
          setView("error");
          return;
        }
        const body = (await res.json()) as { required?: MfaRequired };
        if (body.required === "enroll") setView("enroll");
        else if (body.required === "challenge") setView("challenge");
        else if (body.required === "unavailable") setView("unavailable");
        else goNext(target);
      } catch (err) {
        setError((err as Error).message || "Network error.");
        setView("error");
      }
    })();
  }, [goNext]);

  async function submitChallenge(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = code.trim();
    if (!/^(\d{6}|[0-9a-fA-F]{5}-?[0-9a-fA-F]{5})$/.test(trimmed)) {
      setError("Enter the 6-digit code from your authenticator app, or a recovery code.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetchWithRefresh("/api/auth/mfa/challenge", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ code: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.status === 429) {
        setError("Too many wrong codes. Wait 15 minutes and try again.");
        return;
      }
      if (!res.ok || !body.ok) {
        setError(body.error === "bad_code" ? "That code didn't match. Try the current code." : body.error || `Verification failed (HTTP ${res.status}).`);
        return;
      }
      goNext(next);
    } catch (err) {
      setError((err as Error).message || "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="mfa-page"
      data-view={view}
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--wp-dark)" }}
    >
      <div
        className="w-full max-w-md rounded-xl border p-6 sm:p-8"
        style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
      >
        <h1 className="text-2xl font-bold mb-2" style={{ color: "var(--wp-gold)" }}>
          {view === "challenge" ? "Verify it's you" : "Multi-factor authentication"}
        </h1>

        {view === "loading" && (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }} data-testid="mfa-page-loading">
            Checking your account…
          </p>
        )}

        {view === "enroll" && (
          <div data-testid="mfa-page-enroll" className="space-y-3">
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
              Your account has admin access, so it needs a second factor before you continue. Set it up now; it
              takes about a minute.
            </p>
            <MfaSettingsCard mode="required" onComplete={() => goNext(next)} />
          </div>
        )}

        {view === "challenge" && (
          <form onSubmit={submitChallenge} className="space-y-3" data-testid="mfa-page-challenge">
            <p className="text-sm" style={{ color: "var(--wp-text-muted)" }}>
              Enter the 6-digit code from your authenticator app. Lost it? Use one of your recovery codes.
            </p>
            <input
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              data-testid="mfa-challenge-input"
              aria-label="Authentication code"
              className="w-full px-3 py-2 rounded tracking-widest"
              style={{
                background: "var(--wp-dark-surface2)",
                border: "1px solid var(--wp-dark-border)",
                color: "var(--wp-text)",
                fontSize: "16px",
              }}
            />
            <button
              type="submit"
              disabled={busy}
              data-testid="mfa-challenge-submit"
              className="w-full rounded-lg px-4 py-2.5 font-medium"
              style={{ background: "var(--wp-gold)", color: "var(--wp-dark)", opacity: busy ? 0.6 : 1 }}
            >
              {busy ? "Verifying…" : "Verify"}
            </button>
          </form>
        )}

        {view === "unavailable" && (
          <p className="text-sm" style={{ color: "var(--wp-warning)" }} data-testid="mfa-page-unavailable">
            The MFA check is temporarily unavailable. Reload in a moment.
          </p>
        )}

        {error && (
          <p className="text-sm mt-3" style={{ color: "var(--wp-danger, #f87171)" }} data-testid="mfa-page-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
