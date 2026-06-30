"use client";

/**
 * MfaSettingsCard — self-service, OPT-IN multi-factor auth (TOTP) management.
 *
 * Mounted in /settings inside a <SectionCard title="Multi-factor authentication">.
 * Drives the four /api/auth/mfa/* routes via fetchWithRefresh (never raw fetch,
 * per the no-raw-api-fetch guardrail). States:
 *   - loading       — fetching status on mount
 *   - disabled      — no enrollment: "Enable" button
 *   - enrolling     — secret + otpauth URL shown, awaiting a 6-digit code
 *   - recovery      — codes shown ONCE after a successful verify
 *   - confirmed     — active: shows remaining recovery codes + "Disable"
 *
 * NON-ENFORCING: nothing here changes the login flow; a user who never enables
 * MFA is unaffected.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

interface StatusResponse {
  enrolled: boolean;
  confirmed: boolean;
  recoveryCodesRemaining: number;
  confirmedAt: string | null;
}

type View = "loading" | "disabled" | "enrolling" | "recovery" | "confirmed";

const dimText = { color: "var(--wp-text-dim)" };
const mutedText = { color: "var(--wp-text-muted)" };
const inputStyle = {
  background: "var(--wp-dark-surface2)",
  border: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text)",
  fontSize: "16px",
} as const;

export default function MfaSettingsCard() {
  const [view, setView] = useState<View>("loading");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/auth/mfa/status");
      if (!res.ok) {
        setError(`Could not load MFA status (HTTP ${res.status})`);
        setView("disabled");
        return;
      }
      const body = (await res.json()) as StatusResponse;
      setStatus(body);
      setView(body.confirmed ? "confirmed" : "disabled");
    } catch (err) {
      setError((err as Error).message || "Network error");
      setView("disabled");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function startEnroll() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetchWithRefresh("/api/auth/mfa/enroll", { method: "POST", headers: jsonHeaders() });
      const body = (await res.json().catch(() => ({}))) as { secret?: string; otpauthUrl?: string; error?: string };
      if (!res.ok || !body.secret) {
        setError(body.error || `Could not start enrollment (HTTP ${res.status})`);
        return;
      }
      setSecret(body.secret);
      setOtpauth(body.otpauthUrl ?? null);
      setView("enrolling");
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetchWithRefresh("/api/auth/mfa/verify", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ code: code.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; recoveryCodes?: string[]; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error === "bad_code" ? "That code didn't match. Try the current code." : body.error || `Verification failed (HTTP ${res.status})`);
        return;
      }
      setRecoveryCodes(body.recoveryCodes ?? []);
      setCode("");
      setSecret(null);
      setView("recovery");
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetchWithRefresh("/api/auth/mfa/disable", { method: "POST", headers: jsonHeaders() });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error || `Could not disable MFA (HTTP ${res.status})`);
        return;
      }
      setRecoveryCodes([]);
      setSecret(null);
      setOtpauth(null);
      await loadStatus();
    } catch (err) {
      setError((err as Error).message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="mfa-settings-card">
      <p className="text-xs" style={dimText}>
        Add a one-time code from an authenticator app (Google Authenticator, 1Password, Authy) as a
        second factor on your account. Optional — your login works the same with or without it.
      </p>

      {error && (
        <p className="text-xs" style={{ color: "var(--wp-danger, #f87171)" }} data-testid="mfa-error">
          {error}
        </p>
      )}

      {view === "loading" && (
        <p className="text-sm" style={dimText} data-testid="mfa-loading">
          Checking MFA status…
        </p>
      )}

      {view === "disabled" && (
        <div data-testid="mfa-disabled">
          <p className="text-sm" style={mutedText}>
            Multi-factor authentication is <strong>off</strong> for your account.
          </p>
          <button
            type="button"
            onClick={startEnroll}
            disabled={busy}
            data-testid="mfa-enable-btn"
            className="mt-2 px-3 py-2 rounded text-sm"
            style={{ background: "var(--wp-accent, #6366f1)", color: "#fff", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Starting…" : "Enable MFA"}
          </button>
        </div>
      )}

      {view === "enrolling" && (
        <form onSubmit={confirmCode} className="space-y-3" data-testid="mfa-enrolling">
          <p className="text-sm" style={mutedText}>
            Scan this in your authenticator app, or enter the setup key manually, then type the 6-digit code to confirm.
          </p>
          {otpauth && (
            <div data-testid="mfa-otpauth" className="text-xs break-all" style={dimText}>
              {/* The client draws the QR from this otpauth:// URI (no server QR lib). */}
              <code>{otpauth}</code>
            </div>
          )}
          {secret && (
            <div>
              <span className="block text-xs mb-1" style={mutedText}>Setup key</span>
              <code data-testid="mfa-secret" className="text-sm px-2 py-1 rounded" style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-text)" }}>
                {secret}
              </code>
            </div>
          )}
          <div>
            <label className="block text-xs mb-1" style={mutedText}>6-digit code</label>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              data-testid="mfa-code-input"
              className="w-40 px-3 py-2 rounded tracking-widest"
              style={inputStyle}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            data-testid="mfa-confirm-btn"
            className="px-3 py-2 rounded text-sm"
            style={{ background: "var(--wp-accent, #6366f1)", color: "#fff", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Verifying…" : "Confirm & enable"}
          </button>
        </form>
      )}

      {view === "recovery" && (
        <div data-testid="mfa-recovery">
          <p className="text-sm" style={{ color: "var(--wp-text)" }}>
            MFA is now <strong>on</strong>. Save these recovery codes somewhere safe — each works once
            if you lose your authenticator. They won&apos;t be shown again.
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-1" data-testid="mfa-recovery-codes">
            {recoveryCodes.map((rc) => (
              <li key={rc}>
                <code className="text-sm" style={{ color: "var(--wp-text)" }}>{rc}</code>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void loadStatus()}
            data-testid="mfa-recovery-done-btn"
            className="mt-3 px-3 py-2 rounded text-sm"
            style={{ background: "var(--wp-dark-surface2)", border: "1px solid var(--wp-dark-border)", color: "var(--wp-text)" }}
          >
            I&apos;ve saved them
          </button>
        </div>
      )}

      {view === "confirmed" && (
        <div data-testid="mfa-confirmed">
          <p className="text-sm" style={{ color: "var(--wp-text)" }}>
            Multi-factor authentication is <strong>on</strong> for your account.
            {status ? ` ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? "" : "s"} remaining.` : ""}
          </p>
          <button
            type="button"
            onClick={disable}
            disabled={busy}
            data-testid="mfa-disable-btn"
            className="mt-2 px-3 py-2 rounded text-sm"
            style={{ background: "transparent", border: "1px solid var(--wp-dark-border)", color: "var(--wp-danger, #f87171)", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Disabling…" : "Disable MFA"}
          </button>
        </div>
      )}
    </div>
  );
}
