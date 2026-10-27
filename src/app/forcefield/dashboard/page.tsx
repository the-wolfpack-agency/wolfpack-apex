"use client";

/**
 * Forcefield client dashboard - /forcefield/dashboard
 *
 * A CLIENT's own protection numbers, scoped to their tenant. It is PUBLIC (no
 * apex login): the client pastes the per-tenant ingest token they were issued at
 * onboarding, and we call /api/forcefield/my-stats with it in the
 * `x-forcefield-token` header. The token is the credential; it is kept only in
 * this browser (localStorage) so a returning client sees their numbers without
 * re-pasting. An unknown / disabled token gets a clear "not recognized" message,
 * never another tenant's data (the isolation is enforced server-side).
 *
 * This closes the onboarding loop: operator provisions the tenant -> client wires
 * the edge shim -> client watches Forcefield working on their own site here.
 *
 * The my-stats fetch is a RAW fetch (not fetchWithRefresh) on purpose: there is no
 * apex session or JWT here, the ingest token IS the auth, so there is no refresh
 * flow to run. Same posture as the public /share and /s token pages. This file is
 * listed in the no-raw-api-fetch guardrail exceptions for that reason.
 */
import { useCallback, useEffect, useState } from "react";
import { GlassPanel, MetricTile, SectionHeader, ConsoleGrid, StatusPill } from "@/components/console";
import { AlertEmailPanel } from "@/components/forcefield/AlertEmailPanel";
import { attackLabel } from "@/lib/forcefield-web/attack-labels";

const TOKEN_KEY = "ff_dashboard_token";

interface Stats {
  rangeDays: number;
  agentsDetected: number;
  welcomed: number;
  trapped: number;
  probed: number;
  payloads: number;
  hostile: number;
  sitesProtected: number;
  attacks: Array<{ attack: string; count: number }>;
}
type Handling = "blocked" | "slowed" | "welcomed" | "caught" | "watched";
interface Activity {
  counts: { agentsSeen: number; welcomed: number; slowed: number; blocked: number; caught: number };
  agents: Array<{ name: string; kind: string; requests: number; did: string; handled: Handling; lastSeen: string | null }>;
}
interface MyStatsResponse {
  ok: boolean;
  /** Who visited: each agent, what it did, how Forcefield handled it. */
  activity?: Activity;
  tenant?: { id: string; name: string; siteLabel: string };
  stats?: Stats;
  /** True when the tenant is licensed to ACTUALLY block; false = watch-only (free
   *  tier). Drives honest labeling and the upgrade prompt. Absent -> watch-only. */
  enforcing?: boolean;
  plan?: string;
  error?: string;
}
interface Quickstart {
  cloudflareEnv: Record<string, string>;
  nextEnv: Record<string, string>;
  nextSnippet: string;
}
interface MySetupResponse {
  ok: boolean;
  tenant?: { id: string; name: string; siteLabel: string };
  /** Null when signed in with a dashboard session (the plugin holds the key). */
  quickstart?: Quickstart | null;
  connection?: { connected: boolean; everConnected?: boolean; lastEventAt: string | null };
}

function envBlock(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

/** Shared plain-language attack names (forcefield-web/attack-labels.ts), sentence-cased. */
const prettyAttack = (a: string) => {
  const l = attackLabel(a);
  return l.charAt(0).toUpperCase() + l.slice(1);
};
const HANDLED: Record<Handling, { label: string; color: string }> = {
  blocked: { label: "Blocked", color: "#f87171" },
  slowed: { label: "Slowed", color: "#fb923c" },
  welcomed: { label: "Welcomed", color: "#34d399" },
  caught: { label: "Caught (watch mode)", color: "#fbbf24" },
  watched: { label: "Watched", color: "var(--wp-muted, #9aa0a6)" },
};


export default function ForcefieldDashboardPage() {
  const [input, setInput] = useState("");
  const [token, setToken] = useState("");
  const [data, setData] = useState<MyStatsResponse | null>(null);
  const [setup, setSetup] = useState<MySetupResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "unauthorized" | "error">("idle");

  // The onboarding payload: the client's copy-paste quick-start + whether we have
  // seen traffic yet. Isolated (own try/catch) so it never affects the stats view.
  const loadSetup = useCallback(async (t: string) => {
    if (!t) return;
    setChecking(true);
    try {
      const res = await fetch("/api/forcefield/my-setup", {
        headers: { "x-forcefield-token": t },
        cache: "no-store",
      });
      if (res.ok) setSetup((await res.json()) as MySetupResponse);
    } catch { /* leave setup as-is; the stats view does not depend on it */ }
    setChecking(false);
  }, []);

  const load = useCallback(async (t: string) => {
    if (!t) return;
    setStatus("loading");
    try {
      const res = await fetch("/api/forcefield/my-stats", {
        headers: { "x-forcefield-token": t },
        cache: "no-store",
      });
      if (res.status === 401) {
        setStatus("unauthorized");
        setData(null);
        try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
        return;
      }
      if (!res.ok) {
        setStatus("error");
        return;
      }
      const body = (await res.json()) as MyStatsResponse;
      setData(body);
      setToken(t);
      setStatus("ok");
      try { window.localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
      void loadSetup(t);
    } catch {
      setStatus("error");
    }
  }, [loadSetup]);

  // Restore a previously-connected token so a returning client lands on their numbers.
  useEffect(() => {
    let saved = "";
    try { saved = window.localStorage.getItem(TOKEN_KEY) ?? ""; } catch { /* ignore */ }
    if (saved) {
      void load(saved);
    }
  }, [load]);

  const connect = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const t = input.trim();
      if (!t) return;
      void load(t);
    },
    [input, load],
  );

  const disconnect = useCallback(() => {
    setInput("");
    setToken("");
    setData(null);
    setSetup(null);
    setStatus("idle");
    try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }, []);

  const stats = data?.stats;
  const connected = status === "ok" && !!stats;
  // Enforce-to-paid: licensed tenants block for real; the free tier watches only.
  // We label honestly off this flag and never claim "stopped" when we only watched.
  const enforcing = data?.enforcing === true;
  const receiving = setup?.connection?.connected === true;
  // Wired at some point but no recent traffic: a shim that went quiet or a site
  // that stopped sending. Surface honestly, never as a false "Connected".
  const stale = !receiving && (setup?.connection?.everConnected === true || (!!setup?.connection?.lastEventAt && setup?.connection?.connected === false));

  return (
    <main
      className="min-h-screen px-4 py-10 sm:px-8"
      style={{ background: "var(--wp-bg, #0b0d11)", color: "var(--wp-ink, #e8eaed)" }}
    >
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-8 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ogiam-logo.png" alt="OGIAM" width={32} height={32} style={{ height: 32, width: "auto" }} />
          <div>
            <h1 className="text-2xl font-medium tracking-[-0.01em]">Forcefield</h1>
            <p className="text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
              Your live protection, scoped to your site.
            </p>
          </div>
        </header>

        {!connected && (
          <GlassPanel
            testId="ff-token-form"
            padded
            title="Connect your dashboard"
            subtitle="Open the sign-in link from your Forcefield email, or paste the site key you were given at onboarding. It stays in this browser."
          >
            <form onSubmit={connect} className="mt-4 flex flex-col gap-3 sm:flex-row">
              <input
                data-testid="ff-token-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="ff_..."
                className="flex-1 rounded-md border px-3 py-2 text-sm"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  borderColor: "rgba(255,255,255,0.12)",
                  color: "var(--wp-ink, #e8eaed)",
                }}
              />
              <button
                data-testid="ff-connect"
                type="submit"
                disabled={status === "loading" || !input.trim()}
                className="rounded-md px-5 py-2 text-sm font-medium disabled:opacity-50"
                style={{ background: "var(--wp-gold, #e8b528)", color: "#0b0d11" }}
              >
                {status === "loading" ? "Connecting..." : "Connect"}
              </button>
            </form>
            <p className="mt-3 text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
              New to Forcefield? <a data-testid="ff-start-link" href="/forcefield/signup" style={{ color: "var(--wp-gold, #e8b528)" }}>Add your site</a>.
            </p>
            {status === "unauthorized" && (
              <p data-testid="ff-error" className="mt-3 text-sm" style={{ color: "#f87171" }}>
                That token was not recognized. Check that you pasted the full token from your
                onboarding email, or contact your OGIAM contact to re-issue it.
              </p>
            )}
            {status === "error" && (
              <p data-testid="ff-error" className="mt-3 text-sm" style={{ color: "#f87171" }}>
                Could not reach the protection network just now. Please try again in a moment.
              </p>
            )}
          </GlassPanel>
        )}

        {connected && stats && (
          <section data-testid="ff-stats">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <SectionHeader
                title={data?.tenant?.name ? `${data.tenant.name}` : "Your site"}
                subtitle={`Last ${stats.rangeDays} days`}
              />
              <div className="flex items-center gap-3">
                <StatusPill status="live" tone="success" label="Live" />
                <button
                  data-testid="ff-disconnect"
                  type="button"
                  onClick={disconnect}
                  className="text-xs underline"
                  style={{ color: "var(--wp-muted, #9aa0a6)" }}
                >
                  Change token
                </button>
              </div>
            </div>

            {!enforcing && stats.hostile > 0 && (
              <div className="mb-6">
                <GlassPanel
                  testId="ff-upsell"
                  padded
                  glow="gold"
                  title="Watch-only: these were caught, not blocked"
                  subtitle="Your plan watches and reports hostile agents. Blocking turns them away automatically."
                >
                  <p className="mt-3 text-sm" style={{ color: "var(--wp-ink, #e8eaed)" }}>
                    In the last {stats.rangeDays} days Forcefield caught{" "}
                    <span data-testid="ff-upsell-count" className="font-semibold tabular-nums" style={{ color: "#f87171" }}>
                      {stats.hostile.toLocaleString()}
                    </span>{" "}
                    proven-hostile {stats.hostile === 1 ? "action" : "actions"} on your site. On a
                    protection plan, every one of these is turned away at the edge before it reaches you,
                    automatically and with no change to your setup.
                  </p>
                  <p className="mt-3 text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
                    Talk to your OGIAM contact to enable blocking. Watching stays on either way.
                  </p>
                </GlassPanel>
              </div>
            )}

            {setup?.quickstart && (
              <div className="mb-6">
                <GlassPanel
                  testId="ff-setup"
                  padded
                  glow={receiving ? "none" : "gold"}
                  title="Finish setup"
                  subtitle={
                    receiving
                      ? "Forcefield is receiving traffic from your site. You are protected."
                      : stale
                        ? "We saw your site before, but no traffic recently. Check that the shim is still deployed."
                        : "Two steps to go live: add the config to your site, then check the connection."
                  }
                >
                  <div className="mt-3 flex items-center gap-2" data-testid="ff-connection">
                    <StatusPill
                      status={receiving ? "live" : stale ? "degraded" : "queued"}
                      tone={receiving ? "success" : stale ? "warning" : undefined}
                      label={receiving ? "Connected" : stale ? "No recent traffic" : "Waiting for traffic"}
                    />
                    <button
                      data-testid="ff-check-connection"
                      type="button"
                      onClick={() => void loadSetup(token)}
                      disabled={checking}
                      className="text-xs underline"
                      style={{ color: "var(--wp-muted, #9aa0a6)" }}
                    >
                      {checking ? "Checking..." : "Check connection"}
                    </button>
                  </div>

                  {!receiving && !stale && (
                    <>
                      <p className="mt-4 text-[13px]" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
                        Option A - Cloudflare Worker (any site). Set these variables:
                      </p>
                      <pre data-testid="ff-setup-cf" className="mt-1 overflow-x-auto rounded-md p-3 text-xs"
                        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.12)" }}>{envBlock(setup.quickstart.cloudflareEnv)}</pre>
                      <p className="mt-4 text-[13px]" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
                        Option B - Next.js site. Add the middleware and these variables:
                      </p>
                      <pre data-testid="ff-setup-next" className="mt-1 overflow-x-auto rounded-md p-3 text-xs"
                        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.12)" }}>{setup.quickstart.nextSnippet + "\n\n" + envBlock(setup.quickstart.nextEnv)}</pre>
                      <p className="mt-3 text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
                        Forcefield starts in watch-only mode (it never blocks your traffic) until you set
                        FORCEFIELD_ENFORCE=on. Deploy, then click Check connection.
                      </p>
                    </>
                  )}
                </GlassPanel>
              </div>
            )}

            {token && (
              <div className="mb-6">
                <AlertEmailPanel token={token} site={data?.tenant?.siteLabel ?? "your site"} />
              </div>
            )}

            {!setup?.quickstart && setup?.connection && (
              <div className="mb-6 flex items-center gap-2" data-testid="ff-connection">
                <StatusPill
                  status={receiving ? "live" : stale ? "degraded" : "queued"}
                  tone={receiving ? "success" : stale ? "warning" : undefined}
                  label={receiving ? "Connected" : stale ? "No recent traffic" : "Waiting for the first visitor"}
                />
                <button data-testid="ff-check-connection" type="button" onClick={() => void loadSetup(token)} disabled={checking} className="text-xs underline" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
                  {checking ? "Checking..." : "Check connection"}
                </button>
              </div>
            )}

            {data?.activity && (
              <div className="mb-6">
                <GlassPanel testId="ff-visitors" padded title="Who visited" subtitle="Each automated agent, what it did, and how Forcefield handled it">
                  <div className="mt-3 flex flex-wrap gap-2 text-xs" data-testid="ff-visitor-counts">
                    {([
                      ["ff-v-seen", "Agents seen", data.activity.counts.agentsSeen],
                      ["ff-v-welcomed", "Welcomed", data.activity.counts.welcomed],
                      ["ff-v-slowed", "Slowed", data.activity.counts.slowed],
                      ["ff-v-blocked", "Blocked", data.activity.counts.blocked],
                      ["ff-v-caught", "Caught in watch mode", data.activity.counts.caught],
                    ] as const).map(([id, label, value]) => (
                      <span key={id} data-testid={id} className="rounded-md px-2.5 py-1" style={{ background: "rgba(255,255,255,0.05)" }}>
                        {label}: <strong className="tabular-nums">{value.toLocaleString()}</strong>
                      </span>
                    ))}
                  </div>
                  {data.activity.agents.length === 0 ? (
                    <p data-testid="ff-visitors-empty" className="mt-3 text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
                      No automated agents yet. When bots and AI agents reach your site, each one appears here with what it did.
                    </p>
                  ) : (
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-left text-sm" data-testid="ff-visitors-table">
                        <thead>
                          <tr className="text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
                            <th className="py-2 pr-3 font-normal">Agent</th>
                            <th className="py-2 pr-3 font-normal">What it did</th>
                            <th className="py-2 pr-3 font-normal">Forcefield</th>
                            <th className="py-2 text-right font-normal">Requests</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.activity.agents.map((a) => (
                            <tr key={a.name} data-testid="ff-visitor-row" className="border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                              <td className="py-2 pr-3">{a.name}</td>
                              <td className="py-2 pr-3" style={{ color: "var(--wp-muted, #9aa0a6)" }}>{a.did}</td>
                              <td className="py-2 pr-3" style={{ color: HANDLED[a.handled]?.color }}>{HANDLED[a.handled]?.label ?? a.handled}</td>
                              <td className="py-2 text-right tabular-nums">{a.requests.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </GlassPanel>
              </div>
            )}

            <ConsoleGrid>
              <MetricTile testId="ff-m-detected" value={stats.agentsDetected} label="Automated agents seen" />
              <MetricTile testId="ff-m-welcomed" value={stats.welcomed} label="Good bots welcomed" accent="var(--wp-gold)" />
              <MetricTile testId="ff-m-hostile" value={stats.hostile} label={enforcing ? "Hostile actions stopped" : "Hostile actions caught"} accent="#f87171" />
              <MetricTile testId="ff-m-trapped" value={stats.trapped} label="Trapped in the honeypot" />
              <MetricTile testId="ff-m-probed" value={stats.probed} label="Sensitive-path probes" />
              <MetricTile testId="ff-m-payloads" value={stats.payloads} label="Payload attacks" />
            </ConsoleGrid>

            <div className="mt-6">
              <GlassPanel testId="ff-attacks" padded title="What they tried" subtitle="Hostile requests by type">
                {stats.attacks.length === 0 ? (
                  <p data-testid="ff-attacks-empty" className="mt-3 text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
                    No attacks recorded in this window. The shield is up and watching.
                  </p>
                ) : (
                  <ul className="mt-3 flex flex-col gap-2">
                    {stats.attacks.map((a) => (
                      <li
                        key={a.attack}
                        data-testid={`ff-attack-${a.attack}`}
                        className="flex items-center justify-between rounded-md px-3 py-2 text-sm"
                        style={{ background: "rgba(255,255,255,0.03)" }}
                      >
                        <span>{prettyAttack(a.attack)}</span>
                        <span className="font-medium tabular-nums" style={{ color: "#f87171" }}>
                          {a.count.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </GlassPanel>
            </div>

            <p className="mt-6 text-xs" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
              These numbers are counts only, aggregated from your site&apos;s traffic. No visitor
              identities or page contents are shown. Scoped to {data?.tenant?.siteLabel ?? "your site"}.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
