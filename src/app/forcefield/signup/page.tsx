"use client";

/**
 * Forcefield self-serve start - /forcefield/signup. The whole journey is two
 * actions: (1) enter the website and email here, (2) click the one install
 * button that fits the site's platform.
 *
 * The form POSTs to the public /api/forcefield/onboarding:
 *   - 201 (self-serve): the browser keeps the one-time setup key, and this page
 *     shows the install option for the platform the server detected from the
 *     site's home page (read-only, SSRF-guarded):
 *       wordpress  the plugin (download now; the directory install once listed).
 *                  The plugin's Connect button proves ownership itself and the
 *                  emailed sign-in link finishes the connection.
 *       vercel     the Vercel / Next.js setup.
 *       other      "Connect it for me" (the concierge request) or set it up.
 *     /forcefield/setup keeps the DNS record / file path for every platform.
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
import {
  SETUP_KEY_STORAGE,
  writeStored,
  WORDPRESS_DIRECTORY_LISTED,
  WORDPRESS_PLUGIN_DOWNLOAD,
  wordpressInstallUrl,
  type SignupPlatform,
} from "@/lib/forcefield-web/onboarding-client";
const HONEYPOT_FIELD = "_hp_company";

interface Started { site: string; email: string; platform: SignupPlatform; setupKey: string }

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
  const [started, setStarted] = useState<Started | null>(null);
  const [concierge, setConcierge] = useState<"idle" | "sending" | "done" | "error">("idle");

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
        const body = (await res.json().catch(() => ({}))) as { mode?: string; setupKey?: string; site?: string; email?: string; platform?: string };
        if (res.status === 201 && body.mode === "self_serve" && body.setupKey) {
          writeStored(SETUP_KEY_STORAGE, body.setupKey);
          const platform: SignupPlatform = body.platform === "wordpress" || body.platform === "vercel" ? body.platform : "other";
          setStarted({ site: body.site ?? siteUrl, email: body.email ?? email, platform, setupKey: body.setupKey });
          setStatus("idle");
          return;
        }
        setStatus("done");
      } catch {
        setStatus("error");
      }
    },
    [name, email, siteUrl, note, hp, status],
  );

  const askConcierge = useCallback(async () => {
    if (!started || concierge === "sending") return;
    setConcierge("sending");
    try {
      const res = await fetch("/api/forcefield/onboarding/concierge", {
        method: "POST",
        headers: { "x-forcefield-setup": started.setupKey, "Content-Type": "application/json" },
        body: JSON.stringify({ note: `Requested from the signup page (platform: ${started.platform})` }),
      });
      setConcierge(res.ok ? "done" : "error");
    } catch {
      setConcierge("error");
    }
  }, [started, concierge]);

  // Both required fields gate the button, so an empty form never posts.
  const canSubmit = mounted && status !== "sending" && siteUrl.trim().length > 0 && email.trim().length > 0;

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
            <p className="text-sm" style={muted}>
              Two steps: add your site and the email for its alerts, then click one install button.
            </p>
          </div>
        </header>

        {started ? (
          <InstallStep started={started} concierge={concierge} onConcierge={() => void askConcierge()} onSetup={() => router.push("/forcefield/setup")} />
        ) : status === "done" ? (
          <div
            data-testid="ff-signup-done"
            className="rounded-lg border p-6"
            style={{ borderColor: "rgba(232,181,40,0.4)", background: "rgba(232,181,40,0.06)" }}
          >
            <h2 className="text-lg font-medium" style={{ color: "var(--wp-gold, #e8b528)" }}>Request received</h2>
            <p className="mt-2 text-sm" style={muted}>
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
            <Field label="Email for alerts and sign-in">
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
              data-testid="ff-s-submit" type="submit" disabled={!canSubmit}
              className="mt-1 rounded-md px-5 py-2.5 text-sm font-medium disabled:opacity-50"
              style={goldBtn}
            >
              {status === "sending" ? "Checking your site..." : "Start protecting my site"}
            </button>
            <p className="text-xs" style={muted}>
              Next we show the one install step that fits your site. We never share your details.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}

const PLATFORM_LABEL: Record<SignupPlatform, string> = { wordpress: "WordPress", vercel: "Vercel / Next.js", other: "" };
const goldBtn: React.CSSProperties = { background: "var(--wp-gold, #e8b528)", color: "#0b0d11" };
const muted: React.CSSProperties = { color: "var(--wp-muted, #9aa0a6)" };
const outlineBtn: React.CSSProperties = { borderColor: "rgba(255,255,255,0.18)" };
const VERCEL_INSTALL_URL = process.env.NEXT_PUBLIC_FORCEFIELD_VERCEL_INSTALL_URL ?? "";

/** Step 2: the one install option for the detected platform. */
function InstallStep({ started, concierge, onConcierge, onSetup }: {
  started: Started;
  concierge: "idle" | "sending" | "done" | "error";
  onConcierge: () => void;
  onSetup: () => void;
}) {
  const { site, email, platform } = started;
  return (
    <section
      data-testid="ff-install" data-platform={platform}
      className="rounded-lg border p-6"
      style={{ borderColor: "rgba(232,181,40,0.4)", background: "rgba(232,181,40,0.06)" }}
    >
      <p className="text-xs uppercase tracking-[0.08em]" style={muted}>Step 2 of 2</p>
      <h2 className="mt-1 text-lg font-medium">
        {platform === "other" ? `Connect ${site}` : `${site} runs ${PLATFORM_LABEL[platform]}`}
      </h2>

      {platform === "wordpress" && (
        <div data-testid="ff-install-wordpress">
          <p className="mt-2 text-sm" style={muted}>
            Install the Forcefield plugin, then open Settings, Forcefield in your WordPress admin and click Connect.
            The plugin proves it runs on your site, so there is no key to copy and no DNS change. We then email a
            sign-in link to {email}. Click it and protection starts in watch mode.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {WORDPRESS_DIRECTORY_LISTED ? (
              <a data-testid="ff-install-wordpress-button" href={wordpressInstallUrl(site)} target="_blank" rel="noopener noreferrer" className="rounded-md px-5 py-2.5 text-sm font-medium" style={goldBtn}>
                Install the WordPress plugin
              </a>
            ) : (
              <>
                <a data-testid="ff-install-wordpress-button" href={WORDPRESS_PLUGIN_DOWNLOAD} download className="rounded-md px-5 py-2.5 text-sm font-medium" style={goldBtn}>
                  Download the WordPress plugin
                </a>
                <a data-testid="ff-install-wordpress-upload" href={wordpressInstallUrl(site)} target="_blank" rel="noopener noreferrer" className="rounded-md border px-4 py-2.5 text-sm" style={outlineBtn}>
                  Upload it in your WordPress admin
                </a>
              </>
            )}
          </div>
        </div>
      )}

      {platform === "vercel" && (
        <div data-testid="ff-install-vercel">
          <p className="mt-2 text-sm" style={muted}>
            {VERCEL_INSTALL_URL
              ? "Add Forcefield to your Vercel project. It writes the edge middleware settings for you, with nothing to code."
              : "Add the Forcefield edge middleware and your site key to the Vercel project. The next page walks you through it."}
          </p>
          <div className="mt-4">
            {VERCEL_INSTALL_URL ? (
              <a data-testid="ff-install-vercel-button" href={VERCEL_INSTALL_URL} className="inline-block rounded-md px-5 py-2.5 text-sm font-medium" style={goldBtn}>Add to Vercel</a>
            ) : (
              <button data-testid="ff-install-vercel-button" type="button" onClick={onSetup} className="rounded-md px-5 py-2.5 text-sm font-medium" style={goldBtn}>Connect your Vercel site</button>
            )}
          </div>
        </div>
      )}

      {platform === "other" && (
        <div data-testid="ff-install-other">
          <p className="mt-2 text-sm" style={muted}>
            We could not tell which platform {site} runs on. We can connect it with you, usually in one short call, and
            nothing changes on your site until you agree.
          </p>
          <div className="mt-4">
            {concierge === "done" ? (
              <p data-testid="ff-install-concierge-done" className="text-sm" style={{ color: "#34d399" }}>Request received. We will email {email} to set a time.</p>
            ) : (
              <button data-testid="ff-install-concierge" type="button" onClick={onConcierge} disabled={concierge === "sending"} className="rounded-md px-5 py-2.5 text-sm font-medium disabled:opacity-50" style={goldBtn}>
                {concierge === "sending" ? "Sending..." : "Connect it for me"}
              </button>
            )}
            {concierge === "error" && <p className="mt-2 text-xs" style={{ color: "#f87171" }}>Could not send the request. Please try again.</p>}
          </div>
        </div>
      )}

      <p className="mt-5 text-xs" style={muted}>
        Prefer another way?{" "}
        <button data-testid="ff-install-setup" type="button" onClick={onSetup} className="underline">Connect with a DNS record, a file or a code snippet</button>.
        Forcefield starts in watch mode and never blocks a visitor until you turn blocking on.
      </p>
    </section>
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
      <span style={muted}>{label}</span>
      {children}
    </label>
  );
}
