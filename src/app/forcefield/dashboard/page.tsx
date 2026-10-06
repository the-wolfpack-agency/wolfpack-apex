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
interface MyStatsResponse {
  ok: boolean;
  tenant?: { id: string; name: string; siteLabel: string };
  stats?: Stats;
  error?: string;
}

const ATTACK_LABELS: Record<string, string> = {
  path_traversal: "Path traversal",
  open_redirect: "Open redirect",
  xss: "Cross-site scripting",
  sql_injection: "SQL injection",
  command_injection: "Command injection",
  xxe: "XML external entity",
  ssrf: "Server-side request forgery",
};
const prettyAttack = (a: string) =>
  ATTACK_LABELS[a] ?? a.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function ForcefieldDashboardPage() {
  const [input, setInput] = useState("");
  const [data, setData] = useState<MyStatsResponse | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "unauthorized" | "error">("idle");

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
      setStatus("ok");
      try { window.localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
    } catch {
      setStatus("error");
    }
  }, []);

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
    setData(null);
    setStatus("idle");
    try { window.localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }, []);

  const stats = data?.stats;
  const connected = status === "ok" && !!stats;

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
            subtitle="Paste the Forcefield token you were given at onboarding. It stays in this browser."
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

            <ConsoleGrid>
              <MetricTile testId="ff-m-detected" value={stats.agentsDetected} label="Automated agents seen" />
              <MetricTile testId="ff-m-welcomed" value={stats.welcomed} label="Good bots welcomed" accent="var(--wp-gold)" />
              <MetricTile testId="ff-m-hostile" value={stats.hostile} label="Hostile actions stopped" accent="#f87171" />
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
