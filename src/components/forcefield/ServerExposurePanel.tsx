"use client";

/**
 * "Is your server exposed?" on the Forcefield client dashboard.
 *
 * The WordPress plugin reports the server's PHP, WordPress and active plugin
 * versions on link and then daily; /api/forcefield/my-exposure matches them
 * against the actively exploited flaws Forcefield tracks. Clear states only:
 *   - exposed: what, in plain words, and who fixes it;
 *   - up to date: no tracked actively exploited flaw affects these versions;
 *   - could not check: the version did not allow a certain answer (never shown
 *     as safe or as exposed);
 *   - empty: the plugin has not reported yet;
 *   - error: the check could not be loaded.
 * Authorized by the tenant credential (x-forcefield-token) the dashboard
 * already holds; raw fetch is correct (no apex session), listed in the
 * no-raw-api-fetch exceptions.
 */
import { useCallback, useEffect, useState } from "react";
import { GlassPanel, StatusPill } from "@/components/console";
import type { ExposureState, ServerFinding } from "@/lib/forcefield-web/server-exposure";

interface ExposureReport {
  status: ExposureState;
  findings: ServerFinding[];
  otherPlugins: number;
  serverSoftware: string | null;
  kevCatalogDate: string;
  phpVersion: string | null;
  wordpressVersion: string | null;
  receivedAt: string;
}

const STATE: Record<ExposureState, { label: string; tone: "error" | "success" | "warning"; pill: string }> = {
  exposed: { label: "Exposed", tone: "error", pill: "critical" },
  ok: { label: "Up to date", tone: "success", pill: "resolved" },
  unknown: { label: "Could not check", tone: "warning", pill: "degraded" },
};

const HEADLINE: Record<ExposureState, string> = {
  exposed: "Your server is open to an actively exploited flaw",
  ok: "No actively exploited flaw on our list affects your server",
  unknown: "Some of your server could not be checked",
};

const MUTED = "var(--wp-muted, #9aa0a6)";

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString().replace(" GMT", " UTC");
}

export function ServerExposurePanel({ token }: { token: string }) {
  const [report, setReport] = useState<ExposureReport | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "empty" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/forcefield/my-exposure", { headers: { "x-forcefield-token": token }, cache: "no-store" });
      if (!res || !res.ok) { setState("error"); return; }
      const body = (await res.json()) as { ok?: boolean; report?: ExposureReport | null };
      if (!body?.report) { setReport(null); setState("empty"); return; }
      setReport(body.report);
      setState("ok");
    } catch {
      setState("error");
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const status = report?.status;
  return (
    <GlassPanel
      testId="ff-exposure"
      padded
      glow={status === "exposed" ? "gold" : "none"}
      title="Is your server exposed?"
      subtitle="Your server's PHP, WordPress and plugin versions, checked against the flaws attackers are actively using"
    >
      {state === "loading" && (
        <p data-testid="ff-exposure-loading" className="mt-3 text-sm" style={{ color: MUTED }}>Checking your server...</p>
      )}
      {state === "error" && (
        <p data-testid="ff-exposure-error" className="mt-3 text-sm" style={{ color: "#f87171" }}>
          The server check could not be loaded just now. Please try again in a moment.
        </p>
      )}
      {state === "empty" && (
        <p data-testid="ff-exposure-empty" className="mt-3 text-sm" style={{ color: MUTED }}>
          No server report yet. Once the Forcefield WordPress plugin is connected it reports your
          server&apos;s PHP, WordPress and plugin versions (versions only, nothing else) and then
          checks again every day.
        </p>
      )}
      {state === "ok" && report && status && (
        <div className="mt-3" data-testid="ff-exposure-report" data-state={status}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill testId="ff-exposure-status" status={STATE[status].pill} tone={STATE[status].tone} label={STATE[status].label} />
            <span className="text-sm font-medium" data-testid="ff-exposure-headline">{HEADLINE[status]}</span>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {report.findings.map((f) => (
              <li
                key={f.key}
                data-testid="ff-exposure-row"
                data-state={f.state}
                data-key={f.key}
                className="rounded-md px-3 py-2 text-sm"
                style={{ background: "rgba(255,255,255,0.03)", borderLeft: `3px solid ${f.state === "exposed" ? "#f87171" : f.state === "ok" ? "#34d399" : "#fbbf24"}` }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {f.productName}{f.installed ? ` ${f.installed}` : ""}
                  </span>
                  <span className="text-xs" style={{ color: f.state === "exposed" ? "#f87171" : f.state === "ok" ? "#34d399" : "#fbbf24" }}>
                    {STATE[f.state].label}
                  </span>
                </div>
                <p className="mt-1" style={{ color: "var(--wp-ink, #e8eaed)" }}>{f.summary}</p>
                {f.state === "exposed" && f.howToFix && (
                  <p className="mt-1" data-testid="ff-exposure-fix" style={{ color: MUTED }}>
                    <strong style={{ color: "var(--wp-ink, #e8eaed)" }}>How to fix it: </strong>{f.howToFix}
                  </p>
                )}
                {f.state === "unknown" && f.fixedVersion && (
                  <p className="mt-1 text-xs" style={{ color: MUTED }}>Fixed in {f.productName} {f.fixedVersion} and later.</p>
                )}
                {f.cves.length > 0 && f.state !== "ok" && (
                  <p className="mt-1 text-xs" style={{ color: MUTED }}>Reference: {f.cves.join(", ")}</p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs" style={{ color: MUTED }} data-testid="ff-exposure-meta">
            {report.otherPlugins > 0 ? `${report.otherPlugins} other active ${report.otherPlugins === 1 ? "plugin is" : "plugins are"} not on the actively exploited list. ` : ""}
            Last report {when(report.receivedAt)}. Exploited-flaw list from {report.kevCatalogDate}.
            {status === "exposed" ? " These flaws are in the server software itself, so no plugin can block them; updating is the fix." : ""}
          </p>
        </div>
      )}
    </GlassPanel>
  );
}
