"use client";

/**
 * The shared body of the two public email-link pages (/forcefield/confirm and
 * /forcefield/unsubscribe). The link carries a signed token in ?token=. The page
 * NEVER acts on load: it shows one button, and only a click POSTs the token. A
 * mail scanner that prefetches the link therefore changes nothing.
 *
 * Raw fetch is correct (no session, the token is the credential); the pages are
 * in the no-raw-api-fetch guardrail exceptions with the other /forcefield pages.
 */
import { useCallback, useEffect, useState } from "react";
import { GlassPanel } from "@/components/console";

export interface TokenActionCopy {
  title: string;
  intro: string;
  button: string;
  busy: string;
  done: (site: string) => string;
  /** Message per API error code (invalid, expired, not_found, already_confirmed, ...). */
  errors: Record<string, string>;
  fallbackError: string;
}

export function TokenActionPage({ endpoint, copy, testPrefix }: { endpoint: string; copy: TokenActionCopy; testPrefix: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    try {
      setToken(new URLSearchParams(window.location.search).get("token") ?? "");
    } catch {
      setToken("");
    }
  }, []);

  const act = useCallback(async () => {
    if (!token || status === "sending") return;
    setStatus("sending");
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; site?: string; error?: string };
      if (res.ok && body.ok) {
        setStatus("done");
        setMessage(copy.done(body.site ?? "your site"));
      } else {
        setStatus("error");
        setMessage(copy.errors[body.error ?? ""] ?? copy.fallbackError);
      }
    } catch {
      setStatus("error");
      setMessage(copy.fallbackError);
    }
  }, [token, status, endpoint, copy]);

  return (
    <main className="min-h-screen px-4 py-12 sm:px-8" style={{ background: "var(--wp-bg, #0b0d11)", color: "var(--wp-ink, #e8eaed)" }}>
      <div className="mx-auto w-full max-w-lg">
        <header className="mb-8 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ogiam-logo.png" alt="OGIAM" width={32} height={32} style={{ height: 32, width: "auto" }} />
          <h1 className="text-2xl font-medium tracking-[-0.01em]">{copy.title}</h1>
        </header>
        <GlassPanel testId={`${testPrefix}-panel`} padded>
          {token === null ? null : !token ? (
            <p data-testid={`${testPrefix}-missing`} className="text-sm" style={{ color: "#f87171" }}>
              This link is incomplete. Open the link from the email again, or manage alerts from your dashboard.
            </p>
          ) : status === "done" ? (
            <p data-testid={`${testPrefix}-done`} className="text-sm">{message}</p>
          ) : (
            <>
              <p className="text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>{copy.intro}</p>
              <button
                data-testid={`${testPrefix}-button`}
                type="button"
                onClick={() => void act()}
                disabled={status === "sending"}
                className="mt-4 rounded-md px-5 py-2 text-sm font-medium disabled:opacity-50"
                style={{ background: "var(--wp-gold, #e8b528)", color: "#0b0d11" }}
              >
                {status === "sending" ? copy.busy : copy.button}
              </button>
              {status === "error" && <p data-testid={`${testPrefix}-error`} className="mt-3 text-sm" style={{ color: "#f87171" }}>{message}</p>}
            </>
          )}
          <p className="mt-6 text-xs">
            <a href="/forcefield/dashboard" style={{ color: "var(--wp-gold, #e8b528)" }}>Open your Forcefield dashboard</a>
          </p>
        </GlassPanel>
      </div>
    </main>
  );
}
