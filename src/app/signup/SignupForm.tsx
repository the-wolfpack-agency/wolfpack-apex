"use client";

/**
 * Public signup form: organization name + admin email -> POST /api/signup.
 * Pre-auth (no token exists yet), so it uses raw fetch, like the login page -
 * covered by the no-raw-api-fetch guardrail's src/app/signup exception.
 */
import { useState } from "react";

export default function SignupForm() {
  const [orgName, setOrgName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgName: orgName.trim(), adminEmail: adminEmail.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as { message?: string };
      setResult({ ok: r.ok, text: j.message ?? (r.ok ? "Registered." : "Could not register. Try again.") });
      if (r.ok) {
        setOrgName("");
        setAdminEmail("");
      }
    } catch {
      setResult({ ok: false, text: "Could not reach the server. Try again." });
    } finally {
      setBusy(false);
    }
  }

  const field: React.CSSProperties = {
    padding: "0.6rem 0.7rem",
    borderRadius: 8,
    background: "var(--wp-surface, #171a21)",
    color: "var(--wp-text, #e6e9ef)",
    border: "1px solid var(--wp-border, #2a2f3a)",
    width: "100%",
  };

  return (
    <form onSubmit={submit} data-testid="signup-form" style={{ display: "grid", gap: "0.8rem" }}>
      <label style={{ display: "grid", gap: "0.3rem" }}>
        <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }}>Organization name</span>
        <input type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)} required data-testid="signup-org" placeholder="Acme Inc" style={field} />
      </label>
      <label style={{ display: "grid", gap: "0.3rem" }}>
        <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #b4bcc8)" }}>Admin email</span>
        <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} required data-testid="signup-email" placeholder="you@acme.com" style={field} />
      </label>
      <button
        type="submit"
        disabled={busy || !orgName.trim() || !adminEmail.trim()}
        data-testid="signup-submit"
        style={{ padding: "0.6rem 1.1rem", borderRadius: 8, border: "none", background: "var(--wp-accent, #4c8bf5)", color: "#fff", fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy || !orgName.trim() || !adminEmail.trim() ? 0.6 : 1 }}
      >
        {busy ? "Registering..." : "Create organization"}
      </button>
      {result ? (
        <p data-testid="signup-result" style={{ margin: 0, fontSize: "0.9rem", color: result.ok ? "var(--wp-success, #30a46c)" : "var(--wp-error, #e5484d)" }}>
          {result.text}
        </p>
      ) : null}
    </form>
  );
}
