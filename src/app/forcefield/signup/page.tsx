"use client";

/**
 * Public Forcefield signup - /forcefield/signup
 *
 * A prospect requests access. This is PUBLIC (no account): the form POSTs to the
 * public, gated /api/forcefield/signup, which enqueues a PENDING request for an
 * operator to review. No token is issued here - the success state tells the
 * prospect we will be in touch. A honeypot field + server-side rate limiting
 * guard the endpoint.
 *
 * Raw fetch is correct (no session/JWT pre-account); the file is in the
 * no-raw-api-fetch guardrail exceptions, same as /share, /s, and the dashboard.
 */
import { useCallback, useState } from "react";

const HONEYPOT_FIELD = "_hp_company";

export default function ForcefieldSignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [note, setNote] = useState("");
  const [hp, setHp] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "invalid" | "rate_limited" | "error">("idle");

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (status === "sending") return;
      setStatus("sending");
      try {
        const res = await fetch("/api/forcefield/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, siteUrl, note, [HONEYPOT_FIELD]: hp }),
        });
        if (res.status === 429) { setStatus("rate_limited"); return; }
        if (res.status === 400) { setStatus("invalid"); return; }
        if (!res.ok) { setStatus("error"); return; }
        setStatus("done");
      } catch {
        setStatus("error");
      }
    },
    [name, email, siteUrl, note, hp, status],
  );

  return (
    <main
      className="min-h-screen px-4 py-12 sm:px-8"
      style={{ background: "var(--wp-bg, #0b0d11)", color: "var(--wp-ink, #e8eaed)" }}
    >
      <div className="mx-auto w-full max-w-xl">
        <header className="mb-8 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ogiam-logo.png" alt="OGIAM" width={32} height={32} style={{ height: 32, width: "auto" }} />
          <div>
            <h1 className="text-2xl font-medium tracking-[-0.01em]">Protect your site with Forcefield</h1>
            <p className="text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
              Tell us where to point the shield. We will set you up and send your access.
            </p>
          </div>
        </header>

        {status === "done" ? (
          <div
            data-testid="ff-signup-done"
            className="rounded-lg border p-6"
            style={{ borderColor: "rgba(232,181,40,0.4)", background: "rgba(232,181,40,0.06)" }}
          >
            <h2 className="text-lg font-medium" style={{ color: "var(--wp-gold, #e8b528)" }}>Request received</h2>
            <p className="mt-2 text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
              Thanks. We will review your site and email your access details and a short setup guide. No
              code changes are needed to start, Forcefield begins in watch-only mode.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} data-testid="ff-signup-form" className="flex flex-col gap-4">
            <Field label="Your name">
              <input
                data-testid="ff-s-name" value={name} onChange={(e) => setName(e.target.value)} required
                className="w-full rounded-md border px-3 py-2 text-sm" style={inputStyle}
              />
            </Field>
            <Field label="Work email">
              <input
                data-testid="ff-s-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                className="w-full rounded-md border px-3 py-2 text-sm" style={inputStyle}
              />
            </Field>
            <Field label="Website to protect">
              <input
                data-testid="ff-s-site" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="yourcompany.com" required
                className="w-full rounded-md border px-3 py-2 text-sm" style={inputStyle}
              />
            </Field>
            <Field label="Anything we should know? (optional)">
              <textarea
                data-testid="ff-s-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                className="w-full rounded-md border px-3 py-2 text-sm" style={inputStyle}
              />
            </Field>

            {/* Honeypot: visually hidden, not announced to AT; bots fill it, people don't. */}
            <input
              tabIndex={-1} autoComplete="off" aria-hidden="true"
              name={HONEYPOT_FIELD} value={hp} onChange={(e) => setHp(e.target.value)}
              style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
            />

            {status === "invalid" && (
              <p data-testid="ff-signup-error" className="text-sm" style={{ color: "#f87171" }}>
                Please enter your name, a valid work email, and the website you want protected.
              </p>
            )}
            {status === "rate_limited" && (
              <p data-testid="ff-signup-error" className="text-sm" style={{ color: "#f87171" }}>
                Too many requests from your network just now. Please try again in a few minutes.
              </p>
            )}
            {status === "error" && (
              <p data-testid="ff-signup-error" className="text-sm" style={{ color: "#f87171" }}>
                Something went wrong sending your request. Please try again in a moment.
              </p>
            )}

            <button
              data-testid="ff-s-submit" type="submit" disabled={status === "sending"}
              className="mt-1 rounded-md px-5 py-2.5 text-sm font-medium disabled:opacity-50"
              style={{ background: "var(--wp-gold, #e8b528)", color: "#0b0d11" }}
            >
              {status === "sending" ? "Sending..." : "Request access"}
            </button>
            <p className="text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
              We review each request before issuing access. We never share your details.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  borderColor: "rgba(255,255,255,0.12)",
  color: "var(--wp-ink, #e8eaed)",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span style={{ color: "var(--wp-muted, #9aa0a6)" }}>{label}</span>
      {children}
    </label>
  );
}
