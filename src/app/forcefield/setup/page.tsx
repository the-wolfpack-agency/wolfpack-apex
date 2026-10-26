"use client";

/**
 * Forcefield self-serve setup - /forcefield/setup (steps 2 to 4).
 *
 *   2. Prove you own the site: one DNS TXT record (or one text file), then one
 *      click on "Verify ownership" (the platform-scan ownership check).
 *   3. Connect: the lightest option available today for the site's stack (the
 *      existing quick-start), a "we'll do it for you" request, and the planned
 *      no-code DNS connect shown as coming soon.
 *   4. Confirm the alert email: the double opt-in link we emailed.
 *
 * PUBLIC page (no apex session). The one-time setup key from step 1 is kept in
 * this browser and sent as x-forcefield-setup; after ownership is proven the
 * tenant's ingest token is kept as the dashboard token (x-forcefield-token).
 * Raw fetch is correct here (no JWT); the file is in the no-raw-api-fetch
 * guardrail exceptions with the other /forcefield pages.
 */
import { useCallback, useEffect, useState } from "react";
import { GlassPanel, StatusPill } from "@/components/console";
import { SETUP_KEY_STORAGE, DASHBOARD_TOKEN_STORAGE, readStored, writeStored, clearStored } from "@/lib/forcefield-web/onboarding-client";

interface Instruction { method: "dns_txt" | "http_well_known"; summary: string; location: string; value: string }
interface OnboardingState {
  requestId: string;
  site: string;
  email: string;
  step: "verify" | "connect";
  ownership: { verified: boolean; method: string | null; verifiedAt: string | null; instructions: Instruction[] };
  tenant: { id: string; siteLabel: string } | null;
  connection: { connected: boolean; everConnected: boolean; lastEventAt: string | null } | null;
  notify: { email: string | null; status: "pending" | "confirmed" | "unsubscribed" | null } | null;
  conciergeRequested: boolean;
}
interface Quickstart {
  connector?: { key: string; title: string; managed: boolean; emits: { next: boolean; cloudflare: boolean }; steps: string[] };
  cloudflareEnv: Record<string, string>;
  nextEnv: Record<string, string>;
  nextSnippet: string;
}

const VERIFY_REASON: Record<string, string> = {
  no_txt_record: "no TXT record found yet (DNS changes can take a few minutes)",
  token_mismatch: "the value found does not match",
  fetch_failed: "the site could not be reached",
  ssrf_blocked: "the site address points somewhere we cannot check",
  no_token_issued: "the challenge expired, start again",
  check_error: "the check could not run",
};
const reasonText = (r: string) => VERIFY_REASON[r] ?? (r.startsWith("http_") ? `the file returned HTTP ${r.slice(5)}` : r.replace(/_/g, " "));

function envBlock(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

const pre: React.CSSProperties = { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.12)", whiteSpace: "pre-wrap", wordBreak: "break-all" };
const muted: React.CSSProperties = { color: "var(--wp-muted, #9aa0a6)" };
const goldBtn: React.CSSProperties = { background: "var(--wp-gold, #e8b528)", color: "#0b0d11" };

function CopyRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2">
      <div className="text-xs" style={muted}>{label}</div>
      <div className="mt-1 flex items-start gap-2">
        <code data-testid={testId} className="flex-1 rounded-md p-2 text-xs" style={pre}>{value}</code>
        <button
          type="button"
          className="rounded-md border px-2 py-1 text-xs"
          style={{ borderColor: "rgba(255,255,255,0.18)" }}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function Step({ n, title, state, children, testId }: { n: number; title: string; state: "done" | "current" | "todo"; children?: React.ReactNode; testId: string }) {
  return (
    <div className="mb-4">
      <GlassPanel testId={testId} padded glow={state === "current" ? "gold" : "none"}>
        <div className="flex items-center gap-3">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
            style={state === "done" ? { background: "rgba(52,211,153,0.15)", color: "#34d399" } : state === "current" ? goldBtn : { background: "rgba(255,255,255,0.06)", ...muted }}
            aria-hidden="true"
          >
            {state === "done" ? "✓" : n}
          </span>
          <h2 className="text-base font-medium">{title}</h2>
          {state === "done" && <span className="sr-only">done</span>}
        </div>
        {children ? <div className="mt-3 sm:pl-10">{children}</div> : null}
      </GlassPanel>
    </div>
  );
}

export default function ForcefieldSetupPage() {
  const [setupKey, setSetupKey] = useState("");
  const [state, setState] = useState<OnboardingState | null>(null);
  const [load, setLoad] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [quickstart, setQuickstart] = useState<Quickstart | null>(null);
  const [connection, setConnection] = useState<OnboardingState["connection"]>(null);
  const [concierge, setConcierge] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "error" | "rate_limited">("idle");
  const [emailSent, setEmailSent] = useState<boolean | null>(null);

  const token = typeof window === "undefined" ? "" : readStored(DASHBOARD_TOKEN_STORAGE);

  const loadSetup = useCallback(async (t: string) => {
    if (!t) return;
    try {
      const res = await fetch("/api/forcefield/my-setup", { headers: { "x-forcefield-token": t }, cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { quickstart?: Quickstart; connection?: OnboardingState["connection"] };
        if (body.quickstart) setQuickstart(body.quickstart);
        if (body.connection) setConnection(body.connection);
      }
    } catch { /* the connect step still shows the concierge option */ }
  }, []);

  const loadState = useCallback(async (key: string) => {
    try {
      const res = await fetch("/api/forcefield/onboarding", { headers: { "x-forcefield-setup": key }, cache: "no-store" });
      if (res.status === 401) { clearStored(SETUP_KEY_STORAGE); setLoad("missing"); return; }
      if (!res.ok) { setLoad("error"); return; }
      const body = (await res.json()) as { state: OnboardingState };
      setState(body.state);
      setConnection(body.state.connection);
      if (body.state.conciergeRequested) setConcierge("done");
      setLoad("ok");
      if (body.state.step === "connect") void loadSetup(readStored(DASHBOARD_TOKEN_STORAGE));
    } catch {
      setLoad("error");
    }
  }, [loadSetup]);

  useEffect(() => {
    const key = readStored(SETUP_KEY_STORAGE);
    if (!key) { setLoad("missing"); return; }
    setSetupKey(key);
    void loadState(key);
  }, [loadState]);

  const verify = useCallback(async () => {
    if (verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const res = await fetch("/api/forcefield/onboarding/verify", { method: "POST", headers: { "x-forcefield-setup": setupKey } });
      const body = (await res.json().catch(() => ({}))) as { token?: string; quickstart?: Quickstart; attempts?: { method: string; reason: string }[]; notify?: { delivered: boolean } };
      if (res.ok && body.token) {
        writeStored(DASHBOARD_TOKEN_STORAGE, body.token);
        if (body.quickstart) setQuickstart(body.quickstart);
        setEmailSent(body.notify?.delivered ?? null);
        await loadState(setupKey);
      } else if (res.status === 422) {
        const parts = (body.attempts ?? []).map((a) => `${a.method === "dns_txt" ? "DNS record" : "File"}: ${reasonText(a.reason)}`);
        setVerifyError(`Not verified yet. ${parts.join(". ")}.`);
      } else if (res.status === 429) {
        setVerifyError("Too many checks in a short time. Wait a few minutes and try again.");
      } else if (res.status === 409) {
        await loadState(setupKey);
      } else if (res.status === 401) {
        clearStored(SETUP_KEY_STORAGE);
        setLoad("missing");
      } else {
        setVerifyError("The check could not run just now. Please try again in a moment.");
      }
    } catch {
      setVerifyError("The check could not run just now. Please try again in a moment.");
    }
    setVerifying(false);
  }, [setupKey, verifying, loadState]);

  const askConcierge = useCallback(async () => {
    setConcierge("sending");
    try {
      const res = await fetch("/api/forcefield/onboarding/concierge", {
        method: "POST",
        headers: { "x-forcefield-setup": setupKey, "Content-Type": "application/json" },
        body: JSON.stringify({ note: "Requested from the setup page" }),
      });
      setConcierge(res.ok ? "done" : "error");
    } catch {
      setConcierge("error");
    }
  }, [setupKey]);

  const resendConfirm = useCallback(async () => {
    const t = readStored(DASHBOARD_TOKEN_STORAGE);
    if (!t || !state) return;
    setResend("sending");
    try {
      const res = await fetch("/api/forcefield/alert-email", {
        method: "PUT",
        headers: { "x-forcefield-token": t, "Content-Type": "application/json" },
        body: JSON.stringify({ email: state.notify?.email ?? state.email }),
      });
      if (res.status === 429) { setResend("rate_limited"); return; }
      const body = (await res.json().catch(() => ({}))) as { delivered?: boolean };
      setResend(res.ok ? "sent" : "error");
      if (res.ok) setEmailSent(body.delivered ?? null);
    } catch {
      setResend("error");
    }
  }, [state]);

  const verified = state?.ownership.verified === true;
  const connected = connection?.connected === true || connection?.everConnected === true;
  const notifyStatus = state?.notify?.status ?? null;
  const dns = state?.ownership.instructions.find((i) => i.method === "dns_txt");
  const file = state?.ownership.instructions.find((i) => i.method === "http_well_known");

  return (
    <main className="min-h-screen px-4 py-10 sm:px-8" style={{ background: "var(--wp-bg, #0b0d11)", color: "var(--wp-ink, #e8eaed)" }}>
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-8 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ogiam-logo.png" alt="OGIAM" width={32} height={32} style={{ height: 32, width: "auto" }} />
          <div>
            <h1 className="text-2xl font-medium tracking-[-0.01em]">Set up Forcefield</h1>
            <p className="text-sm" style={muted}>
              {state ? <>Protecting <strong data-testid="ff-setup-site">{state.site}</strong>. Alerts go to {state.email}.</> : "A few minutes from here to your first alert."}
            </p>
          </div>
        </header>

        {load === "loading" && <p data-testid="ff-setup-loading" className="text-sm" style={muted}>Loading your setup...</p>}

        {load === "missing" && (
          <GlassPanel testId="ff-setup-missing" padded title="Start with your site" subtitle="This browser has no Forcefield setup in progress.">
            <p className="mt-3 text-sm" style={muted}>
              Enter your website and alert email to begin. If you already finished setup, open your dashboard.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a href="/forcefield/signup" className="rounded-md px-4 py-2 text-sm font-medium" style={goldBtn}>Start setup</a>
              <a href="/forcefield/dashboard" className="rounded-md border px-4 py-2 text-sm" style={{ borderColor: "rgba(255,255,255,0.18)" }}>Open dashboard</a>
            </div>
          </GlassPanel>
        )}

        {load === "error" && (
          <p data-testid="ff-setup-error" className="text-sm" style={{ color: "#f87171" }}>
            Could not load your setup just now. Please refresh in a moment.
          </p>
        )}

        {load === "ok" && state && (
          <>
            <Step n={1} title="Site added" state="done" testId="ff-step-site" />

            <Step n={2} title="Prove you own the site" state={verified ? "done" : "current"} testId="ff-step-verify">
              {verified ? (
                <p data-testid="ff-verified" className="text-sm" style={muted}>
                  Ownership verified{state.ownership.method === "dns_txt" ? " with your DNS record" : state.ownership.method ? " with your verification file" : ""}.
                </p>
              ) : (
                <>
                  <p className="text-sm" style={muted}>Do one of these, then click Verify. Either one is enough.</p>
                  {dns && (
                    <div className="mt-3">
                      <div className="text-sm font-medium">Option 1: add a DNS TXT record</div>
                      <CopyRow label="Host / name" value={`${dns.location} (use @ if your DNS provider asks)`} testId="ff-dns-host" />
                      <CopyRow label="Value" value={dns.value} testId="ff-dns-value" />
                    </div>
                  )}
                  {file && (
                    <div className="mt-4">
                      <div className="text-sm font-medium">Option 2: publish a small text file</div>
                      <CopyRow label="Address" value={file.location} testId="ff-file-url" />
                      <CopyRow label="File contents" value={file.value} testId="ff-file-value" />
                    </div>
                  )}
                  <button
                    data-testid="ff-verify"
                    type="button"
                    onClick={() => void verify()}
                    disabled={verifying || !setupKey}
                    className="mt-4 rounded-md px-5 py-2 text-sm font-medium disabled:opacity-50"
                    style={goldBtn}
                  >
                    {verifying ? "Checking..." : "Verify ownership"}
                  </button>
                  {verifyError && <p data-testid="ff-verify-error" className="mt-3 text-sm" style={{ color: "#f87171" }}>{verifyError}</p>}
                </>
              )}
            </Step>

            <Step n={3} title="Connect your site" state={!verified ? "todo" : connected ? "done" : "current"} testId="ff-step-connect">
              {verified && (
                <>
                  <div className="mb-3 flex items-center gap-2" data-testid="ff-setup-connection">
                    <StatusPill status={connected ? "live" : "queued"} tone={connected ? "success" : undefined} label={connected ? "Connected" : "Waiting for traffic"} />
                    <button type="button" data-testid="ff-setup-check" className="text-xs underline" style={muted} onClick={() => void loadSetup(readStored(DASHBOARD_TOKEN_STORAGE))}>
                      Check connection
                    </button>
                  </div>

                  <div data-testid="ff-nocode" className="rounded-md border p-3 text-sm" style={{ borderColor: "rgba(232,181,40,0.35)" }}>
                    <div className="font-medium">Coming soon: connect with one DNS record, no code</div>
                    <p className="mt-1 text-xs" style={muted}>
                      Point one DNS record at Forcefield and we protect your site at our edge. Until then, use one of the options below or let us do it for you.
                    </p>
                  </div>

                  <div className="mt-3 rounded-md border p-3 text-sm" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                    <div className="font-medium">We will do it for you</div>
                    <p className="mt-1 text-xs" style={muted}>We connect the site with you, usually in one short call. Nothing changes on your site until you agree.</p>
                    {concierge === "done" ? (
                      <p data-testid="ff-concierge-done" className="mt-2 text-xs" style={{ color: "#34d399" }}>Request received. We will email {state.email} to set a time.</p>
                    ) : (
                      <button data-testid="ff-concierge" type="button" onClick={() => void askConcierge()} disabled={concierge === "sending"}
                        className="mt-2 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50" style={{ borderColor: "rgba(255,255,255,0.18)" }}>
                        {concierge === "sending" ? "Sending..." : "Connect it for me"}
                      </button>
                    )}
                    {concierge === "error" && <p className="mt-2 text-xs" style={{ color: "#f87171" }}>Could not send the request. Please try again.</p>}
                  </div>

                  {quickstart ? (
                    <details data-testid="ff-diy" className="mt-3 rounded-md border p-3 text-sm" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                      <summary className="cursor-pointer font-medium">Connect it yourself{quickstart.connector ? ` (${quickstart.connector.title})` : ""}</summary>
                      {quickstart.connector?.steps?.length ? (
                        <ol className="mt-2 list-decimal pl-5 text-xs" style={muted}>
                          {quickstart.connector.steps.map((s) => <li key={s}>{s}</li>)}
                        </ol>
                      ) : null}
                      {(quickstart.connector?.emits.cloudflare ?? true) && (
                        <>
                          <p className="mt-3 text-xs" style={muted}>Cloudflare Worker (any site behind Cloudflare). Set these variables:</p>
                          <pre data-testid="ff-diy-cf" className="mt-1 overflow-x-auto rounded-md p-3 text-xs" style={pre}>{envBlock(quickstart.cloudflareEnv)}</pre>
                        </>
                      )}
                      {(quickstart.connector?.emits.next ?? true) && (
                        <>
                          <p className="mt-3 text-xs" style={muted}>Next.js / Vercel. Add this middleware and these variables:</p>
                          <pre data-testid="ff-diy-next" className="mt-1 max-h-64 overflow-auto rounded-md p-3 text-xs" style={pre}>{quickstart.nextSnippet + "\n\n" + envBlock(quickstart.nextEnv)}</pre>
                        </>
                      )}
                      <p className="mt-2 text-xs" style={muted}>Forcefield starts in watch mode and never blocks a visitor until you turn blocking on.</p>
                    </details>
                  ) : !token ? (
                    <p data-testid="ff-diy-missing" className="mt-3 text-xs" style={muted}>
                      Your site key is saved in the browser you verified from. Open the dashboard there, or ask us to connect it for you.
                    </p>
                  ) : null}
                </>
              )}
            </Step>

            <Step n={4} title="Confirm your alert email" state={!verified ? "todo" : notifyStatus === "confirmed" ? "done" : "current"} testId="ff-step-email">
              {verified && notifyStatus === "confirmed" && (
                <p data-testid="ff-email-confirmed" className="text-sm" style={muted}>
                  Alerts for {state.site} go to {state.notify?.email}. The first one arrives when Forcefield sees your site&apos;s traffic.
                </p>
              )}
              {verified && notifyStatus === "pending" && (
                <>
                  <p data-testid="ff-email-pending" className="text-sm">
                    {emailSent === false
                      ? `We could not send the confirmation email to ${state.notify?.email} yet. Use Resend to try again.`
                      : `We sent a confirmation link to ${state.notify?.email}. Click Confirm alerts in that email to turn alerts on.`}
                  </p>
                  <button data-testid="ff-email-resend" type="button" onClick={() => void resendConfirm()} disabled={resend === "sending"}
                    className="mt-2 text-xs underline disabled:opacity-50" style={muted}>
                    {resend === "sending" ? "Sending..." : "Resend the email"}
                  </button>
                  {resend === "sent" && <p data-testid="ff-email-resent" className="mt-1 text-xs" style={{ color: "#34d399" }}>Sent again.</p>}
                  {resend === "rate_limited" && <p className="mt-1 text-xs" style={{ color: "#f87171" }}>Too many emails in the last hour. Try again later.</p>}
                  {resend === "error" && <p className="mt-1 text-xs" style={{ color: "#f87171" }}>Could not resend just now.</p>}
                </>
              )}
              {verified && (notifyStatus === null || notifyStatus === "unsubscribed") && (
                <p data-testid="ff-email-none" className="text-sm" style={muted}>No alert email is active. Set one from your dashboard.</p>
              )}
            </Step>

            {verified && (
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <a data-testid="ff-open-dashboard" href="/forcefield/dashboard" className="rounded-md px-5 py-2 text-sm font-medium" style={goldBtn}>Open your dashboard</a>
                <span className="text-xs" style={muted}>Your dashboard shows what Forcefield sees on {state.site}.</span>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
