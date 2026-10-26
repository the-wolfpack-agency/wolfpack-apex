"use client";

/**
 * Forcefield self-serve start - /forcefield/signup (step 1 of the onboarding).
 *
 * A person enters the website to protect and the email that should receive its
 * alerts. The form POSTs to the public /api/forcefield/onboarding:
 *   - 201 (self-serve): the browser keeps the one-time setup key and continues
 *     to /forcefield/setup (prove ownership, connect, confirm the address).
 *   - 202 (request): during the build phase an address outside the Wolfpack
 *     recipient allowlist is filed for review instead; we show "request
 *     received" and nothing is emailed.
 * A honeypot field + server-side rate limiting guard the endpoint.
 *
 * Raw fetch is correct (no session/JWT pre-account); the file is in the
 * no-raw-api-fetch guardrail exceptions, same as /share, /s, and the dashboard.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SETUP_KEY_STORAGE, writeStored } from "@/lib/forcefield-web/onboarding-client";
const HONEYPOT_FIELD = "_hp_company";

export default function ForcefieldSignupPage() {
  const router = useRouter();
  // Submit stays disabled until hydration, so a fast click never posts a native form.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
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
        const res = await fetch("/api/forcefield/onboarding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, email, siteUrl, note, [HONEYPOT_FIELD]: hp }),
        });
        if (res.status === 429) { setStatus("rate_limited"); return; }
        if (res.status === 400) { setStatus("invalid"); return; }
        if (!res.ok) { setStatus("error"); return; }
        const body = (await res.json().catch(() => ({}))) as { mode?: string; setupKey?: string };
        if (res.status === 201 && body.mode === "self_serve" && body.setupKey) {
          writeStored(SETUP_KEY_STORAGE, body.setupKey);
          router.push("/forcefield/setup");
          return;
        }
        setStatus("done");
      } catch {
        setStatus("error");
      }
    },
    [name, email, siteUrl, note, hp, status, router],
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
              Add your site and the email that should get its alerts. Setup takes a few minutes.
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
              Thanks. Self-serve setup is open to a limited group right now, so we will review your site
              and be in touch. Forcefield begins in watch-only mode and never blocks a visitor until you
              turn blocking on.
            </p>
          </div>
        ) : (
          <form onSubmit={submit} data-testid="ff-signup-form" className="flex flex-col gap-4">
            <Field label="Website to protect">
              <input
                data-testid="ff-s-site" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="yourcompany.com" required autoComplete="url" inputMode="url"
                className="w-full rounded-md border px-3 py-2 text-sm" style={inputStyle}
              />
            </Field>
            <Field label="Email for alerts">
              <input
                data-testid="ff-s-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email"
                className="w-full rounded-md border px-3 py-2 text-sm" style={inputStyle}
              />
            </Field>
            <Field label="Your name or company (optional)">
              <input
                data-testid="ff-s-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization"
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
                Please enter the website you want protected and a valid email for its alerts.
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
              data-testid="ff-s-submit" type="submit" disabled={!mounted || status === "sending"}
              className="mt-1 rounded-md px-5 py-2.5 text-sm font-medium disabled:opacity-50"
              style={{ background: "var(--wp-gold, #e8b528)", color: "#0b0d11" }}
            >
              {status === "sending" ? "Starting..." : "Start protecting my site"}
            </button>
            <p className="text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
              Next you will prove you own the site with one DNS record or file, then connect it. We never share your details.
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
