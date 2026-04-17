"use client";

/**
 * Tools — one-click utilities for the team.
 *
 * PDF reports, site previews, visual diffs, and accessibility checks.
 * All powered by AgenticQA/Vibium Python tooling that runs locally
 * (not on Vercel). The API routes gracefully degrade when Python is
 * unavailable.
 */

import { useEffect, useState } from "react";
import {
  authHeaders as canonicalAuthHeaders,
  jsonHeaders as canonicalJsonHeaders,
  fetchWithRefresh,
} from "@/lib/client-auth";

function authHeaders(): HeadersInit {
  return canonicalAuthHeaders();
}
function jsonHeaders(): HeadersInit {
  return canonicalJsonHeaders();
}

/* ─── Types ─────────────────────────────────────────────────────────── */

interface SiteOption {
  id: string;
  display_name: string;
}

interface DiffResult {
  path: string;
  status: "unchanged" | "changed";
  change_pct?: number;
}

interface A11yIssue {
  rule: string;
  severity: "critical" | "serious" | "moderate" | "minor";
  description: string;
  count: number;
}

interface A11yResult {
  score: number;
  issues: A11yIssue[];
}

/* ─── Shared styles ─────────────────────────────────────────────────── */

const cardStyle: React.CSSProperties = {
  background: "var(--wp-card)",
  border: "1px solid var(--wp-border)",
  borderRadius: "8px",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

const btnPrimary: React.CSSProperties = {
  background: "var(--wp-gold)",
  color: "var(--wp-dark)",
  border: "none",
  padding: "0.6rem 1.2rem",
  borderRadius: "6px",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: "0.9rem",
};

const btnDisabled: React.CSSProperties = {
  ...btnPrimary,
  opacity: 0.55,
  cursor: "not-allowed",
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.7rem",
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-border)",
  borderRadius: "6px",
  color: "var(--wp-text)",
  fontSize: "0.9rem",
};

const severityColors: Record<string, string> = {
  critical: "var(--wp-error, #c44)",
  serious: "var(--wp-error, #c44)",
  moderate: "var(--wp-warning, #e8a838)",
  minor: "var(--wp-text-dim)",
};

/* ─── Component ─────────────────────────────────────────────────────── */

export default function ToolsPage() {
  // Shared
  const [sites, setSites] = useState<SiteOption[]>([]);

  // Card 1: PDF Report
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfMsg, setPdfMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Card 2: Demo Deck
  const [deckTarget, setDeckTarget] = useState("instinct");
  const [deckLoading, setDeckLoading] = useState(false);
  const [deckMsg, setDeckMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [deckPaths, setDeckPaths] = useState<string[]>([]);

  // Card 3: Visual Diff
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffMsg, setDiffMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [diffResults, setDiffResults] = useState<DiffResult[]>([]);

  // Card 4: Accessibility
  const [a11yLoading, setA11yLoading] = useState(false);
  const [a11yMsg, setA11yMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [a11yResult, setA11yResult] = useState<A11yResult | null>(null);

  // Load sites for the dropdown
  useEffect(() => {
    fetchWithRefresh("/api/sites", { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => setSites(data.projects ?? []))
      .catch(() => {});
  }, []);

  /* ── Card 1: PDF Report ─────────────────────────────────────────── */

  async function handlePdf() {
    setPdfLoading(true);
    setPdfMsg(null);
    try {
      const r = await fetchWithRefresh("/api/tools/pdf-report", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const data = await r.json();
        setPdfMsg({ type: "err", text: data.message ?? data.error ?? "Failed to generate report" });
        return;
      }
      // If the response is a PDF, trigger download
      const ct = r.headers.get("content-type") ?? "";
      if (ct.includes("application/pdf")) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "instinct-security-report.pdf";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setPdfMsg({ type: "ok", text: "Report downloaded." });
      } else {
        const data = await r.json();
        setPdfMsg({ type: data.available === false ? "err" : "ok", text: data.message ?? "Done" });
      }
    } catch (err) {
      setPdfMsg({ type: "err", text: `Network error: ${(err as Error).message}` });
    } finally {
      setPdfLoading(false);
    }
  }

  /* ── Card 2: Demo Deck ──────────────────────────────────────────── */

  async function handleDeck() {
    setDeckLoading(true);
    setDeckMsg(null);
    setDeckPaths([]);
    try {
      const r = await fetchWithRefresh("/api/tools/demo-deck", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ target: deckTarget }),
      });
      const data = await r.json();
      if (!r.ok || data.available === false) {
        setDeckMsg({ type: "err", text: data.message ?? data.error ?? "Failed" });
        return;
      }
      setDeckPaths(data.screenshots ?? []);
      setDeckMsg({ type: "ok", text: `Captured ${(data.screenshots ?? []).length} screenshots.` });
    } catch (err) {
      setDeckMsg({ type: "err", text: `Network error: ${(err as Error).message}` });
    } finally {
      setDeckLoading(false);
    }
  }

  /* ── Card 3: Visual Diff ────────────────────────────────────────── */

  async function handleDiff() {
    setDiffLoading(true);
    setDiffMsg(null);
    setDiffResults([]);
    try {
      const r = await fetchWithRefresh("/api/tools/visual-diff", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok || data.available === false) {
        setDiffMsg({ type: "err", text: data.message ?? data.error ?? "Failed" });
        return;
      }
      setDiffResults(data.results ?? []);
      setDiffMsg({ type: "ok", text: `Compared ${(data.results ?? []).length} pages.` });
    } catch (err) {
      setDiffMsg({ type: "err", text: `Network error: ${(err as Error).message}` });
    } finally {
      setDiffLoading(false);
    }
  }

  /* ── Card 4: Accessibility ──────────────────────────────────────── */

  async function handleA11y() {
    setA11yLoading(true);
    setA11yMsg(null);
    setA11yResult(null);
    try {
      const r = await fetchWithRefresh("/api/tools/accessibility", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ paths: ["/", "/sites", "/knowledge"] }),
      });
      const data = await r.json();
      if (!r.ok || data.available === false) {
        setA11yMsg({ type: "err", text: data.message ?? data.error ?? "Failed" });
        return;
      }
      setA11yResult(data.audit ?? null);
      setA11yMsg({ type: "ok", text: `Accessibility check complete.` });
    } catch (err) {
      setA11yMsg({ type: "err", text: `Network error: ${(err as Error).message}` });
    } finally {
      setA11yLoading(false);
    }
  }

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.8rem", margin: 0 }}>Tools</h1>
        <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
          One-click utilities to generate reports, capture previews, and run checks.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))",
          gap: "1.25rem",
        }}
      >
        {/* ── Card 1: PDF Report ────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <svg style={{ width: 22, height: 22, color: "var(--wp-gold)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Download Security Report</h2>
          </div>
          <p style={{ color: "var(--wp-text-dim)", fontSize: "0.9rem", margin: 0 }}>
            Generate a professional PDF security report for your workspace.
          </p>
          <button
            onClick={handlePdf}
            disabled={pdfLoading}
            style={pdfLoading ? btnDisabled : btnPrimary}
          >
            {pdfLoading ? "Generating report..." : "Generate Report"}
          </button>
          {pdfMsg && (
            <div style={{ fontSize: "0.85rem", color: pdfMsg.type === "ok" ? "var(--wp-success)" : "var(--wp-error, #c44)" }}>
              {pdfMsg.text}
            </div>
          )}
        </div>

        {/* ── Card 2: Demo Deck ─────────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <svg style={{ width: 22, height: 22, color: "var(--wp-gold)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
            </svg>
            <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Capture Site Preview</h2>
          </div>
          <p style={{ color: "var(--wp-text-dim)", fontSize: "0.9rem", margin: 0 }}>
            Take screenshots of every page and create a visual preview deck.
          </p>
          <select
            value={deckTarget}
            onChange={(e) => setDeckTarget(e.target.value)}
            style={selectStyle}
          >
            <option value="instinct">Instinct Dashboard</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
          <button
            onClick={handleDeck}
            disabled={deckLoading}
            style={deckLoading ? btnDisabled : btnPrimary}
          >
            {deckLoading ? "Capturing..." : "Capture Preview"}
          </button>
          {deckMsg && (
            <div style={{ fontSize: "0.85rem", color: deckMsg.type === "ok" ? "var(--wp-success)" : "var(--wp-error, #c44)" }}>
              {deckMsg.text}
            </div>
          )}
          {deckPaths.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "0.5rem", marginTop: "0.5rem" }}>
              {deckPaths.map((p, i) => (
                <div
                  key={i}
                  style={{
                    background: "var(--wp-dark)",
                    border: "1px solid var(--wp-border)",
                    borderRadius: "4px",
                    padding: "0.5rem",
                    fontSize: "0.75rem",
                    color: "var(--wp-text-dim)",
                    textAlign: "center",
                    wordBreak: "break-all",
                  }}
                >
                  {p.split("/").pop()}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Card 3: Visual Diff ───────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <svg style={{ width: 22, height: 22, color: "var(--wp-gold)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
            </svg>
            <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Check for Visual Changes</h2>
          </div>
          <p style={{ color: "var(--wp-text-dim)", fontSize: "0.9rem", margin: 0 }}>
            Compare current pages against the last capture to spot unexpected changes.
          </p>
          <button
            onClick={handleDiff}
            disabled={diffLoading}
            style={diffLoading ? btnDisabled : btnPrimary}
          >
            {diffLoading ? "Running..." : "Run Check"}
          </button>
          {diffMsg && (
            <div style={{ fontSize: "0.85rem", color: diffMsg.type === "ok" ? "var(--wp-success)" : "var(--wp-error, #c44)" }}>
              {diffMsg.text}
            </div>
          )}
          {diffResults.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--wp-border)" }}>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem", color: "var(--wp-text-dim)" }}>Page</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem", color: "var(--wp-text-dim)" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {diffResults.map((d, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--wp-border)" }}>
                    <td style={{ padding: "0.4rem 0.5rem" }}>{d.path}</td>
                    <td style={{ padding: "0.4rem 0.5rem", textAlign: "right", color: d.status === "unchanged" ? "var(--wp-success)" : "var(--wp-error, #c44)" }}>
                      {d.status === "unchanged" ? "No changes" : `Changed — ${d.change_pct ?? 0}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Card 4: Accessibility ─────────────────────────────── */}
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <svg style={{ width: 22, height: 22, color: "var(--wp-gold)" }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
            <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Accessibility Check</h2>
          </div>
          <p style={{ color: "var(--wp-text-dim)", fontSize: "0.9rem", margin: 0 }}>
            Check your pages for accessibility issues that affect screen readers and keyboard users.
          </p>
          <button
            onClick={handleA11y}
            disabled={a11yLoading}
            style={a11yLoading ? btnDisabled : btnPrimary}
          >
            {a11yLoading ? "Running..." : "Run Check"}
          </button>
          {a11yMsg && (
            <div style={{ fontSize: "0.85rem", color: a11yMsg.type === "ok" ? "var(--wp-success)" : "var(--wp-error, #c44)" }}>
              {a11yMsg.text}
            </div>
          )}
          {a11yResult && (
            <div style={{ marginTop: "0.5rem" }}>
              <div
                style={{
                  display: "inline-block",
                  padding: "0.5rem 1rem",
                  borderRadius: "6px",
                  fontWeight: 700,
                  fontSize: "1.3rem",
                  color: a11yResult.score >= 90 ? "var(--wp-success)" : a11yResult.score >= 70 ? "var(--wp-warning, #e8a838)" : "var(--wp-error, #c44)",
                  background: "var(--wp-dark)",
                  border: "1px solid var(--wp-border)",
                  marginBottom: "0.75rem",
                }}
              >
                Score: {a11yResult.score}/100
              </div>
              {a11yResult.issues.length === 0 ? (
                <p style={{ color: "var(--wp-success)", fontSize: "0.85rem", margin: 0 }}>
                  No issues found. Great job!
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {a11yResult.issues.map((issue, i) => (
                    <div
                      key={i}
                      style={{
                        padding: "0.5rem 0.7rem",
                        background: "var(--wp-dark)",
                        border: "1px solid var(--wp-border)",
                        borderRadius: "4px",
                        fontSize: "0.85rem",
                      }}
                    >
                      <span style={{ fontWeight: 600, color: severityColors[issue.severity] ?? "var(--wp-text-dim)" }}>
                        {issue.severity.toUpperCase()}
                      </span>
                      {" "}
                      <span style={{ color: "var(--wp-text-dim)" }}>({issue.count}x)</span>
                      {" — "}
                      {issue.description}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
