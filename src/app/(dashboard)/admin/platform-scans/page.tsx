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
  scanId: string;
  findingCount: number;
  criticalCount: number;
  findings: ScanFindingRow[];
}

const SCAN_PLATFORM = "wolfpack-auto";

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
  routes: number | null;
  findings: number;
  critical: number;
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans");
      if (!res.ok) throw new Error(`Failed to load findings (HTTP ${res.status})`);
      const data = (await res.json()) as { findings?: ScanFindingRow[] };
      setFindings((data.findings ?? []).filter((f) => f.status === "open"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ platform: SCAN_PLATFORM }),
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
      setSummary({ routes, findings: data.findingCount, critical: data.criticalCount });
      await load();
    } catch (e) {
      setScanError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }, [load]);

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
    // Decided findings leave the open list — drop them in place.
    setFindings((prev) => prev.filter((f) => f.id !== id));
  }, []);

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

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.2rem" }}>
        <button
          type="button"
          data-testid="run-scan"
          disabled={scanning}
          onClick={() => void runScan()}
          style={{
            padding: "0.45rem 1rem",
            borderRadius: "0.4rem",
            border: "none",
            cursor: scanning ? "default" : "pointer",
            fontWeight: 600,
            color: "#0b0b0c",
            background: "var(--wp-gold, #f1c233)",
            opacity: scanning ? 0.6 : 1,
          }}
        >
          {scanning ? "Scanning…" : "Run scan"}
        </button>
        {summary && (
          <span data-testid="scan-summary" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
            {summary.routes !== null ? `${summary.routes} route${summary.routes === 1 ? "" : "s"}, ` : ""}
            {summary.findings} finding{summary.findings === 1 ? "" : "s"}, {summary.critical} critical
          </span>
        )}
        {scanError && (
          <span data-testid="scan-error" style={{ fontSize: "0.85rem", color: "var(--wp-error, #ef4444)" }}>
            {scanError}
          </span>
        )}
      </div>

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
    </div>
  );
}
