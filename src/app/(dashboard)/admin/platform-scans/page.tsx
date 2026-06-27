"use client";

/**
 * /admin/platform-scans — review surface for the platform-scan agent.
 *
 * An agent crawls a target platform's routes/journeys and surfaces findings:
 * bugs, UX gaps, broken journeys, security, and performance issues, each with a
 * severity. Findings are gated into the learning loop. A human reviews them
 * here: run a fresh scan, then acknowledge or resolve each open finding (decided
 * rows drop out of the open list in place, like the agent approvals queue).
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). POST bodies use jsonHeaders().
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

type Severity = "critical" | "high" | "medium" | "low";
type Category = "bug" | "ux_gap" | "broken_journey" | "security" | "performance";
type FindingStatus = "open" | "acknowledged" | "resolved";

interface ScanFindingRow {
  id: string;
  scanId: string;
  platform: string;
  route: string;
  severity: Severity;
  category: Category;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
  status: FindingStatus;
  createdAt: string;
}

interface RunScanResponse {
  ok: boolean;
  platform: string;
  mode: string;
  scanId: string;
  findingCount: number;
  criticalCount: number;
  findings: ScanFindingRow[];
}

interface ScanTarget {
  platform: string;
  baseUrl: string;
  hasStatic: boolean;
  hasApi: boolean;
  hasLogin: boolean;
}

type ScanMode = "http" | "static" | "api";

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--wp-error, #ef4444)",
  high: "#f59e0b",
  medium: "var(--wp-gold, #f1c233)",
  low: "var(--wp-text-dim, #aaa)",
};

const CATEGORY_LABEL: Record<Category, string> = {
  bug: "Bug",
  ux_gap: "UX gap",
  broken_journey: "Broken journey",
  security: "Security",
  performance: "Performance",
};

interface RunSummary {
  platform: string;
  mode: string;
  routes: number | null;
  findings: number;
  critical: number;
}

interface FindingsSummary {
  total: number;
  bySeverity: Record<Severity, number>;
  byCategory: Record<string, number>;
}

interface ScanCoverage {
  attempted: number;
  succeeded: number;
  errored: number;
  authRequired: boolean;
  authEstablished: boolean;
  coverageRatio: number;
}

interface ScanHistoryRow {
  id: string;
  platform: string;
  baseUrl: string;
  routeCount: number;
  findingCount: number;
  criticalCount: number;
  createdAt: string;
  // Per-run coverage + the server-computed degraded flag. Null = unknown (older
  // run / external ingest); the UI treats unknown as "cannot claim clean", never
  // as fully covered.
  coverage?: ScanCoverage | null;
  degraded?: boolean | null;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

// The findings list DEFAULTS to the actionable band so the ~73 LOW-severity
// code-smells from a single static scan don't flood the queue. The summary
// rollup still shows full counts (nothing hidden silently) and a chip widens the
// list to every severity — no data is lost, low findings stay reachable.
const ACTIONABLE_SEVERITIES: Severity[] = ["critical", "high"];

const EMPTY_SUMMARY: FindingsSummary = {
  total: 0,
  bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  byCategory: {},
};

// "2026-06-26T..." -> a short relative-ish label, falling back to the raw value.
function whenLabel(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

// Build the scan-coverage health line / warning for the most recent run. Returns
// null when there is no run to describe. A degraded run renders a loud warning so
// a "0 findings" result is NEVER mistaken for a clean bill; a clean, fully-covered
// run renders a quiet confirmation; an unknown-coverage run says so explicitly.
function CoverageHealth({ scan }: { scan: ScanHistoryRow }) {
  const cov = scan.coverage ?? null;

  // Unknown coverage (older run / external ingest): say so - do NOT imply clean.
  if (!cov) {
    return (
      <div
        data-testid="coverage-health"
        data-degraded="unknown"
        style={{
          padding: "0.7rem 1rem",
          marginBottom: "1rem",
          borderRadius: "0.5rem",
          fontSize: "0.85rem",
          color: "var(--wp-text-dim, #aaa)",
          background: "var(--wp-dark-surface, #1f1f22)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        Coverage unknown for the latest scan of {scan.platform} - cannot confirm a clean result.
      </div>
    );
  }

  const degraded = scan.degraded === true;
  const authNote = cov.authRequired
    ? cov.authEstablished
      ? "auth established"
      : "auth NOT established"
    : null;
  const coverageText = `Coverage: ${cov.succeeded}/${cov.attempted} routes${authNote ? `, ${authNote}` : ""}`;

  if (!degraded) {
    return (
      <div
        data-testid="coverage-health"
        data-degraded="false"
        style={{
          padding: "0.7rem 1rem",
          marginBottom: "1rem",
          borderRadius: "0.5rem",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: "var(--wp-success, #22c55e)",
          background: "var(--wp-dark-surface, #1f1f22)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        {coverageText}. This scan fully covered the target.
      </div>
    );
  }

  // Degraded: spell out WHY so the operator never reads 0 findings as "secure".
  const reasons: string[] = [];
  if (cov.errored > 0) reasons.push(`${cov.errored} route${cov.errored === 1 ? "" : "s"} errored`);
  if (cov.authRequired && !cov.authEstablished) reasons.push("auth not established");
  if (cov.attempted > 0 && cov.succeeded / cov.attempted < 0.8) reasons.push("less than 80% of routes reached");
  const why = reasons.join(", ");

  return (
    <div
      data-testid="coverage-health"
      data-degraded="true"
      role="alert"
      style={{
        padding: "0.85rem 1rem",
        marginBottom: "1rem",
        borderRadius: "0.5rem",
        fontSize: "0.85rem",
        color: "var(--wp-text, #eee)",
        background: "rgba(239, 68, 68, 0.12)",
        border: "1px solid var(--wp-error, #ef4444)",
      }}
    >
      <strong style={{ color: "var(--wp-error, #ef4444)" }}>Scan was incomplete{why ? ` (${why})` : ""}.</strong>{" "}
      {coverageText}. This is NOT a clean result - a low-finding count here may reflect what the scan could not reach, not a healthy target.
    </div>
  );
}

function evidenceLine(evidence: Record<string, unknown>): string {
  const parts: string[] = [];
  if (evidence.status !== undefined && evidence.status !== null) parts.push(`status ${String(evidence.status)}`);
  if (typeof evidence.durationMs === "number") parts.push(`${evidence.durationMs}ms`);
  return parts.join(" · ");
}

function FindingRow({
  finding,
  onDecide,
}: {
  finding: ScanFindingRow;
  onDecide: (id: string, status: "acknowledged" | "resolved") => Promise<void>;
}) {
  const [busy, setBusy] = useState<"acknowledged" | "resolved" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  async function run(status: "acknowledged" | "resolved") {
    setBusy(status);
    setRowError(null);
    try {
      await onDecide(finding.id, status);
    } catch (e) {
      setRowError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const ev = evidenceLine(finding.evidence);

  return (
    <div
      data-testid={`finding-row-${finding.id}`}
      style={{
        padding: "0.85rem 1rem",
        background: "var(--wp-dark-surface, #1f1f22)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: "0.5rem",
        marginBottom: "0.6rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <span
          data-testid={`finding-severity-${finding.id}`}
          style={{
            fontSize: "0.7rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            padding: "0.15rem 0.5rem",
            borderRadius: "0.35rem",
            color: "#0b0b0c",
            background: SEVERITY_COLOR[finding.severity],
          }}
        >
          {finding.severity}
        </span>
        <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--wp-text-muted, #6b7280)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {CATEGORY_LABEL[finding.category]}
        </span>
        <span
          data-testid={`finding-platform-${finding.id}`}
          title="Platform this finding was scanned on"
          style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--wp-gold, #f1c233)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: "0.35rem", padding: "0.1rem 0.45rem" }}
        >
          {finding.platform}
        </span>
        <code data-testid={`finding-route-${finding.id}`} style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "var(--wp-text-dim, #aaa)" }}>
          {finding.route}
        </code>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid={`ack-${finding.id}`}
          disabled={busy !== null}
          onClick={() => void run("acknowledged")}
          style={{ padding: "0.35rem 0.8rem", borderRadius: "0.4rem", cursor: "pointer", fontWeight: 600, color: "var(--wp-gold, #f1c233)", background: "transparent", border: "1px solid var(--wp-gold, #f1c233)" }}
        >
          {busy === "acknowledged" ? "Acknowledging…" : "Acknowledge"}
        </button>
        <button
          type="button"
          data-testid={`resolve-${finding.id}`}
          disabled={busy !== null}
          onClick={() => void run("resolved")}
          style={{ padding: "0.35rem 0.8rem", borderRadius: "0.4rem", border: "none", cursor: "pointer", fontWeight: 600, color: "#0b0b0c", background: "var(--wp-success, #22c55e)" }}
        >
          {busy === "resolved" ? "Resolving…" : "Resolve"}
        </button>
      </div>
      <div style={{ marginTop: "0.45rem", fontSize: "0.95rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>
        {finding.title}
      </div>
      <div style={{ marginTop: "0.2rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
        {finding.detail}
      </div>
      {ev && (
        <div data-testid={`finding-evidence-${finding.id}`} style={{ marginTop: "0.35rem", fontSize: "0.78rem", fontFamily: "monospace", color: "var(--wp-text-muted, #6b7280)" }}>
          {ev}
        </div>
      )}
      {rowError && (
        <div data-testid={`finding-error-${finding.id}`} style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "var(--wp-error, #ef4444)" }}>
          {rowError}
        </div>
      )}
    </div>
  );
}

export default function PlatformScansPage() {
  const [findings, setFindings] = useState<ScanFindingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [findingsSummary, setFindingsSummary] = useState<FindingsSummary>(EMPTY_SUMMARY);
  const [scanHistory, setScanHistory] = useState<ScanHistoryRow[]>([]);
  // Which platform to scan + how (black-box HTTP vs white-box source), plus the
  // platform filter for the findings list. An agent can scan many platforms, so
  // the operator always picks one explicitly and every finding is labeled by it.
  const [targets, setTargets] = useState<ScanTarget[]>([]);
  const [selectedPlatform, setSelectedPlatform] = useState<string>("");
  const [mode, setMode] = useState<ScanMode>("http");
  const [filterPlatform, setFilterPlatform] = useState<string>("");
  // Severity band the LIST is narrowed to (defaults to actionable). Empty = all.
  const [severities, setSeverities] = useState<Severity[]>(ACTIONABLE_SEVERITIES);
  const [bulkBusy, setBulkBusy] = useState<"acknowledged" | "resolved" | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const selectedTarget = targets.find((t) => t.platform === selectedPlatform) ?? null;
  const allSeverities = severities.length === 0;

  const load = useCallback(async (platform?: string, sevs?: Severity[]) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (platform) params.set("platform", platform);
      if (sevs && sevs.length > 0) params.set("severity", sevs.join(","));
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await fetchWithRefresh(`/api/admin/platform-scans${qs}`);
      if (!res.ok) throw new Error(`Failed to load findings (HTTP ${res.status})`);
      const data = (await res.json()) as { findings?: ScanFindingRow[] };
      setFindings((data.findings ?? []).filter((f) => f.status === "open"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Severity / category rollup + scan history. A failure leaves the existing
  // (or empty) rollup in place; it never blocks the findings list.
  const loadSummary = useCallback(async (platform?: string) => {
    try {
      const qs = platform ? `?platform=${encodeURIComponent(platform)}` : "";
      const res = await fetchWithRefresh(`/api/admin/platform-scans/summary${qs}`);
      if (!res.ok) return;
      const data = (await res.json()) as { summary?: FindingsSummary; scans?: ScanHistoryRow[] };
      setFindingsSummary(data.summary ?? EMPTY_SUMMARY);
      setScanHistory(data.scans ?? []);
    } catch {
      /* rollup is contextual; the findings list still renders without it. */
    }
  }, []);

  const loadTargets = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/targets");
      if (!res.ok) return;
      const data = (await res.json()) as { targets?: ScanTarget[] };
      const list = data.targets ?? [];
      setTargets(list);
      if (list.length > 0) setSelectedPlatform((p) => p || list[0].platform);
    } catch {
      /* targets are a convenience; a failure leaves the selector empty but the
         page still loads findings. */
    }
  }, []);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  // Load findings on mount and whenever the platform OR severity filter changes
  // (filter "" means all platforms; empty severities means all severities). The
  // summary always reloads with the FULL counts regardless of the list filter.
  useEffect(() => {
    void load(filterPlatform || undefined, severities);
    void loadSummary(filterPlatform || undefined);
  }, [filterPlatform, severities, load, loadSummary]);

  const runScan = useCallback(async () => {
    if (!selectedPlatform) {
      setScanError("Pick a platform to scan.");
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ platform: selectedPlatform, mode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Scan failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as RunScanResponse;
      const routes = (() => {
        const seen = new Set<string>();
        for (const f of data.findings ?? []) seen.add(f.route);
        return seen.size || null;
      })();
      setSummary({ platform: data.platform, mode: data.mode, routes, findings: data.findingCount, critical: data.criticalCount });
      // Surface the just-scanned platform's findings + refresh the rollup/history.
      setFilterPlatform(data.platform);
      await Promise.all([load(data.platform, severities), loadSummary(data.platform)]);
    } catch (e) {
      setScanError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }, [load, loadSummary, selectedPlatform, mode, severities]);

  const decide = useCallback(async (id: string, status: "acknowledged" | "resolved") => {
    const res = await fetchWithRefresh(`/api/admin/platform-scans/findings/${id}`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Action failed (HTTP ${res.status})`);
    }
    // Decided findings leave the open list — drop them in place + refresh the
    // rollup so the severity/category counts track the open queue.
    setFindings((prev) => prev.filter((f) => f.id !== id));
    void loadSummary(filterPlatform || undefined);
  }, [loadSummary, filterPlatform]);

  // Bulk-triage every OPEN finding matching the ACTIVE severity + platform
  // filter — what the operator currently sees, nothing hidden. Resolve is guarded
  // by a confirm. After the batch, reload the list + rollup so counts track.
  const bulkTriage = useCallback(async (status: "acknowledged" | "resolved") => {
    if (status === "resolved" && typeof window !== "undefined") {
      const ok = window.confirm("Resolve all findings shown by the current filter? This triages them in bulk.");
      if (!ok) return;
    }
    setBulkBusy(status);
    setBulkError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/findings/bulk", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          status,
          ...(severities.length > 0 ? { severity: severities.join(",") } : {}),
          ...(filterPlatform ? { platform: filterPlatform } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Bulk action failed (HTTP ${res.status})`);
      }
      await Promise.all([load(filterPlatform || undefined, severities), loadSummary(filterPlatform || undefined)]);
    } catch (e) {
      setBulkError((e as Error).message);
    } finally {
      setBulkBusy(null);
    }
  }, [load, loadSummary, filterPlatform, severities]);

  return (
    <div data-testid="platform-scans-page" style={{ padding: "1.5rem", maxWidth: 920, margin: "0 auto", color: "var(--wp-text, #eee)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>Platform scans</h1>
        <span style={{ flex: 1 }} />
        <Link href="/admin/agents" data-testid="back-to-agents" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
          ← Agents
        </Link>
      </div>
      <p style={{ marginTop: 0, marginBottom: "1rem", fontSize: "0.9rem", color: "var(--wp-text-muted, #6b7280)" }}>
        An agent crawls a target platform&apos;s journeys and surfaces bugs and use-case gaps; each finding is gated into the learning loop.
      </p>

      {(() => {
        const ctrl = {
          padding: "0.4rem 0.6rem", borderRadius: "0.4rem", fontSize: "0.85rem",
          background: "var(--wp-dark-surface, #1f1f22)", color: "var(--wp-text, #eee)",
          border: "1px solid var(--wp-dark-border, #333)",
        } as const;
        return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "1.2rem" }}>
        <label htmlFor="platform-select" style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}>Platform</label>
        <select
          id="platform-select"
          data-testid="platform-select"
          value={selectedPlatform}
          onChange={(e) => { setSelectedPlatform(e.target.value); setMode("http"); }}
          style={ctrl}
        >
          {targets.length === 0 && <option value="">(no targets)</option>}
          {targets.map((t) => (
            <option key={t.platform} value={t.platform}>{t.platform}</option>
          ))}
        </select>
        <select
          data-testid="mode-select"
          value={mode}
          onChange={(e) => setMode(e.target.value as ScanMode)}
          title={selectedTarget?.hasStatic ? "How to scan" : "Source scan not configured for this platform"}
          style={ctrl}
        >
          <option value="http">Live crawl (HTTP){selectedTarget?.hasLogin ? " · authenticated" : ""}</option>
          <option value="static" disabled={!selectedTarget?.hasStatic}>Source scan</option>
          <option value="api" disabled={!selectedTarget?.hasApi}>API contract</option>
        </select>
        <button
          type="button"
          data-testid="run-scan"
          disabled={scanning || !selectedPlatform}
          onClick={() => void runScan()}
          style={{
            padding: "0.45rem 1rem",
            borderRadius: "0.4rem",
            border: "none",
            cursor: scanning || !selectedPlatform ? "default" : "pointer",
            fontWeight: 600,
            color: "#0b0b0c",
            background: "var(--wp-gold, #f1c233)",
            opacity: scanning || !selectedPlatform ? 0.6 : 1,
          }}
        >
          {scanning ? `Scanning ${selectedPlatform}…` : "Run scan"}
        </button>
        {summary && (
          <span data-testid="scan-summary" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
            {summary.platform} ({summary.mode === "static" ? "source" : "HTTP"}):{" "}
            {summary.routes !== null ? `${summary.routes} route${summary.routes === 1 ? "" : "s"}, ` : ""}
            {summary.findings} finding{summary.findings === 1 ? "" : "s"}, {summary.critical} critical
          </span>
        )}
        {scanError && (
          <span data-testid="scan-error" style={{ fontSize: "0.85rem", color: "var(--wp-error, #ef4444)" }}>
            {scanError}
          </span>
        )}
        {targets.length > 1 && (
          <>
            <span style={{ flex: 1 }} />
            <label htmlFor="filter-platform" style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}>Showing</label>
            <select
              id="filter-platform"
              data-testid="filter-platform"
              value={filterPlatform}
              onChange={(e) => setFilterPlatform(e.target.value)}
              style={ctrl}
            >
              <option value="">All platforms</option>
              {targets.map((t) => (
                <option key={t.platform} value={t.platform}>{t.platform}</option>
              ))}
            </select>
          </>
        )}
      </div>
        );
      })()}

      {scanHistory.length > 0 && <CoverageHealth scan={scanHistory[0]} />}

      {(() => {
        const categoryLine = Object.entries(findingsSummary.byCategory)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, n]) => `${CATEGORY_LABEL[cat as Category] ?? cat} ${n}`)
          .join(" · ");
        return (
          <div
            data-testid="findings-summary"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              flexWrap: "wrap",
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
              background: "var(--wp-dark-surface, #1f1f22)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "0.5rem",
            }}
          >
            {SEVERITY_ORDER.map((sev) => {
              const count = findingsSummary.bySeverity[sev];
              return (
                <span
                  key={sev}
                  data-testid={`sev-count-${sev}`}
                  title={`${count} open ${sev} finding${count === 1 ? "" : "s"}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.78rem",
                    fontWeight: 700,
                    padding: "0.2rem 0.6rem",
                    borderRadius: "0.4rem",
                    color: "#0b0b0c",
                    background: SEVERITY_COLOR[sev],
                    opacity: count === 0 ? 0.4 : 1,
                  }}
                >
                  <span style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>{sev}</span>
                  <span>{count}</span>
                </span>
              );
            })}
            <span style={{ flex: 1 }} />
            {categoryLine && (
              <span data-testid="category-breakdown" style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #aaa)" }}>
                {categoryLine}
              </span>
            )}
            <span data-testid="open-total" style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--wp-text-muted, #6b7280)" }}>
              {findingsSummary.total} open
            </span>
          </div>
        );
      })()}

      {(() => {
        // Lower-severity findings hidden by the active band (medium + low when the
        // default actionable band is on). Surfaced as a "show all" affordance so
        // nothing is hidden silently — the data is one click away.
        const hiddenCount = allSeverities
          ? 0
          : SEVERITY_ORDER.filter((s) => !severities.includes(s)).reduce(
              (n, s) => n + findingsSummary.bySeverity[s],
              0,
            );
        const chip = (active: boolean) =>
          ({
            padding: "0.3rem 0.7rem",
            borderRadius: "0.4rem",
            fontSize: "0.78rem",
            fontWeight: 600,
            cursor: "pointer",
            color: active ? "#0b0b0c" : "var(--wp-text-dim, #aaa)",
            background: active ? "var(--wp-gold, #f1c233)" : "transparent",
            border: "1px solid var(--wp-dark-border, #333)",
          }) as const;
        return (
          <div
            data-testid="severity-filter"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}
          >
            <span style={{ fontSize: "0.78rem", color: "var(--wp-text-muted, #6b7280)" }}>Showing severity</span>
            <button
              type="button"
              data-testid="severity-chip-actionable"
              aria-pressed={!allSeverities}
              onClick={() => setSeverities(ACTIONABLE_SEVERITIES)}
              style={chip(!allSeverities)}
            >
              Actionable (critical + high)
            </button>
            <button
              type="button"
              data-testid="severity-chip-all"
              aria-pressed={allSeverities}
              onClick={() => setSeverities([])}
              style={chip(allSeverities)}
            >
              All severities
            </button>
            {hiddenCount > 0 && (
              <button
                type="button"
                data-testid="show-all-severities"
                onClick={() => setSeverities([])}
                style={{ fontSize: "0.78rem", color: "var(--wp-gold, #f1c233)", background: "transparent", border: "none", cursor: "pointer", padding: "0.3rem 0.2rem" }}
              >
                +{hiddenCount} lower-severity hidden — show all
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              data-testid="bulk-acknowledge"
              disabled={bulkBusy !== null || findings.length === 0}
              onClick={() => void bulkTriage("acknowledged")}
              style={{
                padding: "0.35rem 0.8rem", borderRadius: "0.4rem", fontWeight: 600, fontSize: "0.78rem",
                cursor: bulkBusy !== null || findings.length === 0 ? "default" : "pointer",
                color: "var(--wp-gold, #f1c233)", background: "transparent", border: "1px solid var(--wp-gold, #f1c233)",
                opacity: bulkBusy !== null || findings.length === 0 ? 0.5 : 1,
              }}
            >
              {bulkBusy === "acknowledged" ? "Acknowledging…" : "Acknowledge all shown"}
            </button>
            <button
              type="button"
              data-testid="bulk-resolve"
              disabled={bulkBusy !== null || findings.length === 0}
              onClick={() => void bulkTriage("resolved")}
              style={{
                padding: "0.35rem 0.8rem", borderRadius: "0.4rem", border: "none", fontWeight: 600, fontSize: "0.78rem",
                cursor: bulkBusy !== null || findings.length === 0 ? "default" : "pointer",
                color: "#0b0b0c", background: "var(--wp-success, #22c55e)",
                opacity: bulkBusy !== null || findings.length === 0 ? 0.5 : 1,
              }}
            >
              {bulkBusy === "resolved" ? "Resolving…" : "Resolve all shown"}
            </button>
            {bulkError && (
              <span data-testid="bulk-error" style={{ width: "100%", fontSize: "0.8rem", color: "var(--wp-error, #ef4444)" }}>
                {bulkError}
              </span>
            )}
          </div>
        );
      })()}

      {loading ? (
        <p data-testid="findings-loading" style={{ color: "var(--wp-text-dim, #aaa)" }}>Loading…</p>
      ) : error ? (
        <p data-testid="findings-error" style={{ color: "var(--wp-error, #ef4444)" }}>{error}</p>
      ) : findings.length === 0 ? (
        <p data-testid="findings-empty" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          No open findings. Run a scan to check the platform.
        </p>
      ) : (
        <div data-testid="findings-list">
          {findings.map((f) => (
            <FindingRow key={f.id} finding={f} onDecide={decide} />
          ))}
        </div>
      )}

      <div data-testid="scan-history" style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1rem", color: "var(--wp-gold, #f1c233)", marginBottom: "0.6rem" }}>Scan history</h2>
        {scanHistory.length === 0 ? (
          <p data-testid="scan-history-empty" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
            No scans yet.
          </p>
        ) : (
          <div>
            {scanHistory.map((s) => (
              <div
                key={s.id}
                data-testid={`scan-history-row-${s.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  flexWrap: "wrap",
                  padding: "0.55rem 0.85rem",
                  marginBottom: "0.45rem",
                  background: "var(--wp-dark-surface, #1f1f22)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: "0.45rem",
                  fontSize: "0.82rem",
                }}
              >
                <span style={{ fontWeight: 600, color: "var(--wp-gold, #f1c233)" }}>{s.platform}</span>
                <span style={{ color: "var(--wp-text-dim, #aaa)" }}>
                  {s.findingCount} finding{s.findingCount === 1 ? "" : "s"}
                </span>
                {s.criticalCount > 0 && (
                  <span style={{ fontWeight: 600, color: "var(--wp-error, #ef4444)" }}>
                    {s.criticalCount} critical
                  </span>
                )}
                {s.degraded === true && (
                  <span
                    data-testid={`scan-degraded-${s.id}`}
                    title="This scan was incomplete - its result is not a clean bill"
                    style={{
                      fontWeight: 700,
                      fontSize: "0.7rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      padding: "0.1rem 0.45rem",
                      borderRadius: "0.35rem",
                      color: "var(--wp-error, #ef4444)",
                      border: "1px solid var(--wp-error, #ef4444)",
                    }}
                  >
                    incomplete
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <time dateTime={s.createdAt} title={s.createdAt} style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                  {whenLabel(s.createdAt)}
                </time>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
