"use client";

/**
 * /admin/compliance-scan - point it at a client site, press the button, read
 * what came back.
 *
 * THE DESIGN PROBLEM THIS PAGE SOLVES
 *
 * The scan returns three verdicts, not two: present, absent, and UNVERIFIABLE.
 * The whole value of the report is that the third one exists, and the whole risk
 * is that it renders as a soft version of "passed". Someone glancing at a green
 * page will tell a client they are fine.
 *
 * So unverifiable is not styled as a mild pass. It is its own column, its own
 * neutral colour, and its own words: "could not be established". The headline
 * refuses to say "all clear" whenever anything was unverifiable, and the tier
 * banner says in plain language what this scan was not able to look at.
 *
 * Auth: every fetch goes through fetchWithRefresh; an unauthenticated user is
 * redirected to /login, never shown a blank page.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, MetricTile, StatusPill, SectionHeader, type SeverityTone } from "@/components/console";

type Verdict = "present" | "absent" | "unverifiable";

interface Finding {
  id: string;
  title: string;
  verdict: Verdict;
  severity: string;
  detail: string;
  evidence?: Record<string, unknown>;
}

interface AnomalyFinding {
  host: string;
  severity: string;
  novelty: "new" | "known" | "no-baseline";
  vendor: string | null;
  kind: string;
  summary: string;
  explainedBy: { detail: string } | null;
}

interface Report {
  pageUrl: string;
  finalUrl: string;
  tier: "static" | "browser";
  findings: Finding[];
  summary: { total: number; present: number; absent: number; unverifiable: number; headline: string };
  anomaly: {
    findings: AnomalyFinding[];
    disappeared: string[];
    caveats: string[];
    totals: { thirdParties: number; unexplained: number; novel: number };
  };
  error?: string;
  runId: string | null;
  baselineUpdated: boolean;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  present: "In place",
  absent: "Missing",
  unverifiable: "Could not be established",
};

/** Neutral, deliberately NOT green. Not knowing is not a pass, and the tone is
 *  the fastest thing a reader takes in. */
const VERDICT_TONE: Record<Verdict, SeverityTone> = {
  present: "success",
  absent: "error",
  unverifiable: "neutral",
};

const ERROR_COPY: Record<string, string> = {
  target_not_verified:
    "This target has not been ownership-verified yet. Verify it (well-known file or DNS TXT) before scanning, so we only ever scan sites the client has proven they control.",
  unknown_platform: "That target is not set up. Add it under targets first.",
  platform_required: "Choose a target to scan.",
  invalid_path: "That path could not be read. Use a path like /pricing.",
};

export default function ComplianceScanPage() {
  const router = useRouter();
  const [platform, setPlatform] = useState("");
  const [path, setPath] = useState("/");
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Redirect unauthenticated users; never render a blank state.
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push("/login?next=/admin/compliance-scan");
      return;
    }
    setReady(true);
  }, [router]);

  const run = useCallback(async () => {
    if (!platform.trim()) {
      setError("platform_required");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/compliance-scan", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ platform: platform.trim(), path }),
      });
      const body = (await res.json()) as { report?: Report; error?: string };
      if (!res.ok || !body.report) {
        setError(body.error ?? `request_failed_${res.status}`);
        setReport(null);
        return;
      }
      setReport(body.report);
    } catch {
      setError("network_error");
      setReport(null);
    } finally {
      setRunning(false);
    }
  }, [platform, path]);

  if (!ready) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <SectionHeader
        as="h1"
        eyebrow="Platform scan"
        title="Compliance scan"
        subtitle="Check a client site for the things a visitor, a regulator, or a lawyer would look for, and list anything it contacts that nothing accounts for."
      />

      <GlassPanel title="Run a scan">
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: "1 1 16rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Target</span>
            <input
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              placeholder="client-site"
              aria-label="Target"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem", flex: "0 1 12rem" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>Page</span>
            <input value={path} onChange={(e) => setPath(e.target.value)} aria-label="Page path" style={inputStyle} />
          </label>
          <button type="button" onClick={() => void run()} disabled={running} style={buttonStyle(running)}>
            {running ? "Scanning…" : "Run scan"}
          </button>
        </div>
        <p style={{ marginTop: "0.75rem", fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
          Only targets the client has proven they own can be scanned. Nothing is submitted, clicked, or changed on the
          site.
        </p>
        {error && (
          <p role="alert" style={{ marginTop: "0.75rem", color: "var(--wp-danger, #ff6b6b)", fontSize: "0.9rem" }}>
            {ERROR_COPY[error] ?? `The scan could not run (${error}).`}
          </p>
        )}
      </GlassPanel>

      {report && (
        <>
          <GlassPanel title="Result" subtitle={report.finalUrl}>
            <p style={{ fontSize: "1.05rem", marginBottom: "0.75rem" }}>{headlineFor(report)}</p>
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <MetricTile value={report.summary.present} label="In place" />
              <MetricTile value={report.summary.absent} label="Missing" />
              <MetricTile value={report.summary.unverifiable} label="Could not be established" />
              <MetricTile value={report.anomaly.totals.unexplained} label="Unexplained hosts" />
            </div>

            {report.tier === "static" && (
              <p style={noticeStyle}>
                This scan read the page as the server sent it. It did not run the page in a browser, so anything added
                afterwards by JavaScript, including most consent banners and some trackers, is outside what it could
                check.
              </p>
            )}
            {report.error && <p style={noticeStyle}>The page could not be fully read: {report.error}</p>}
            {report.runId === null && <p style={noticeStyle}>This run was not saved.</p>}
          </GlassPanel>

          <GlassPanel title="Checks">
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              {report.findings.map((f) => (
                <li key={f.id} style={rowStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                    <StatusPill status={f.verdict} label={VERDICT_LABEL[f.verdict]} tone={VERDICT_TONE[f.verdict]} size="sm" />
                    <strong>{f.title}</strong>
                  </div>
                  <p style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.9rem" }}>{f.detail}</p>
                </li>
              ))}
            </ul>
          </GlassPanel>

          <GlassPanel
            title="What this page contacts"
            subtitle={`${report.anomaly.totals.thirdParties} third part${report.anomaly.totals.thirdParties === 1 ? "y" : "ies"}`}
          >
            {report.anomaly.findings.length === 0 ? (
              <p style={{ color: "var(--wp-text-dim)" }}>
                Nothing was contacted that the site&apos;s own declarations do not account for.
              </p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {report.anomaly.findings.map((f) => (
                  <li key={f.host} style={rowStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                      <StatusPill status={f.severity} size="sm" />
                      <strong>{f.vendor ?? f.host}</strong>
                      {f.novelty === "new" && <StatusPill status="new" label="New since last scan" size="sm" />}
                    </div>
                    <p style={{ margin: "0.35rem 0 0", color: "var(--wp-text-dim)", fontSize: "0.9rem" }}>{f.summary}</p>
                  </li>
                ))}
              </ul>
            )}

            {report.anomaly.caveats.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <h3 style={{ fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--wp-text-dim)" }}>
                  What this scan could not establish
                </h3>
                <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", color: "var(--wp-text-dim)", fontSize: "0.9rem" }}>
                  {report.anomaly.caveats.map((c) => (
                    <li key={c} style={{ marginBottom: "0.3rem" }}>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </GlassPanel>
        </>
      )}
    </div>
  );
}

/**
 * The headline the client reads first.
 *
 * It never says everything passed while anything was unverifiable. summarize()
 * already refuses to, and this refuses again at the surface, because this is the
 * sentence someone screenshots.
 */
export function headlineFor(report: Report): string {
  if (report.summary.absent === 0 && report.summary.unverifiable === 0 && report.anomaly.totals.unexplained === 0) {
    return `All ${report.summary.total} checks passed, and nothing unexplained was contacted.`;
  }
  const parts: string[] = [];
  if (report.summary.absent > 0) {
    parts.push(`${report.summary.absent} issue${report.summary.absent === 1 ? "" : "s"} to fix`);
  }
  if (report.anomaly.totals.unexplained > 0) {
    parts.push(
      `${report.anomaly.totals.unexplained} host${report.anomaly.totals.unexplained === 1 ? "" : "s"} nothing accounts for`,
    );
  }
  if (report.summary.unverifiable > 0) {
    parts.push(`${report.summary.unverifiable} we could not establish`);
  }
  return `${parts.join(", ")}. ${report.summary.present} checks passed.`;
}

const inputStyle: React.CSSProperties = {
  background: "var(--wp-surface-2, rgba(255,255,255,0.05))",
  border: "1px solid var(--wp-border, rgba(255,255,255,0.12))",
  borderRadius: "0.5rem",
  padding: "0.55rem 0.7rem",
  color: "inherit",
  font: "inherit",
};

const rowStyle: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.1))",
  borderRadius: "0.6rem",
  padding: "0.7rem 0.85rem",
};

const noticeStyle: React.CSSProperties = {
  marginTop: "0.9rem",
  fontSize: "0.85rem",
  color: "var(--wp-text-dim)",
  borderLeft: "2px solid var(--wp-border, rgba(255,255,255,0.2))",
  paddingLeft: "0.7rem",
};

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "0.6rem 1.1rem",
    borderRadius: "0.5rem",
    border: "1px solid var(--wp-border, rgba(255,255,255,0.15))",
    background: disabled ? "var(--wp-surface-2, rgba(255,255,255,0.05))" : "var(--wp-accent, #4f7cff)",
    color: disabled ? "var(--wp-text-dim)" : "#fff",
    cursor: disabled ? "default" : "pointer",
    font: "inherit",
    fontWeight: 600,
  };
}
