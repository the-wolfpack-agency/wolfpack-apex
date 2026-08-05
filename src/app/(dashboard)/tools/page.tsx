"use client";

/**
 * Tools — one-click utilities for the team.
 *
 * PDF reports, site previews, visual diffs, and accessibility checks.
 * All powered by GitHub Actions (tools-runner.yml) so they work from
 * the deployed Vercel URL — no local Python required.
 *
 * Flow:
 *   1. User clicks button -> POST /api/tools/<tool> -> returns run_id
 *   2. Page polls GET /api/tools/status?run_id=X&tool=Y every 5s
 *   3. When completed: show results inline
 */

import { useCallback, useEffect, useRef, useState } from "react";
import BriefReviewPanel from "@/components/BriefReviewPanel";
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

/* ── Types ─────────────────────────────────────────────────────────── */

type ToolName = "pdf-report" | "demo-deck" | "visual-diff" | "accessibility";

interface ToolState {
  phase: "idle" | "starting" | "queued" | "running" | "completed" | "failed" | "not_configured";
  run_id?: number;
  result?: Record<string, unknown>;
  error?: string;
  elapsed_ms?: number;
  lastRun?: string; // ISO date of last completed run
}

interface SiteOption {
  id: string;
  display_name: string;
}

/* ── Shared styles ─────────────────────────────────────────────────── */

const cardStyle: React.CSSProperties = {
  background: "var(--wp-card)",
  border: "1px solid var(--wp-border)",
  borderRadius: "8px",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  minHeight: "220px",
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

const severityColors: Record<string, string> = {
  critical: "var(--wp-error, #c44)",
  serious: "var(--wp-error, #c44)",
  moderate: "var(--wp-warning, #e8a838)",
  minor: "var(--wp-text-dim)",
};

const spinnerStyle: React.CSSProperties = {
  display: "inline-block",
  width: 16,
  height: 16,
  border: "2px solid var(--wp-border)",
  borderTopColor: "var(--wp-gold)",
  borderRadius: "50%",
  animation: "spin 0.8s linear infinite",
  marginRight: "0.5rem",
  verticalAlign: "middle",
};

/* ── Component ─────────────────────────────────────────────────────── */

export default function ToolsPage() {
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [deckTarget, setDeckTarget] = useState("instinct");

  // Each tool gets its own state
  const [toolStates, setToolStates] = useState<Record<ToolName, ToolState>>({
    "pdf-report": { phase: "idle" },
    "demo-deck": { phase: "idle" },
    "visual-diff": { phase: "idle" },
    "accessibility": { phase: "idle" },
  });

  // Polling intervals keyed by tool
  const pollRefs = useRef<Record<string, ReturnType<typeof setInterval> | null>>({});

  // Load sites for the dropdown
  useEffect(() => {
    fetchWithRefresh("/api/sites", { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => setSites(data.projects ?? []))
      .catch(() => {});
  }, []);

  // On mount, check latest run for each tool
  useEffect(() => {
    const tools: ToolName[] = ["pdf-report", "demo-deck", "visual-diff", "accessibility"];
    for (const tool of tools) {
      fetchWithRefresh(`/api/tools/status?tool=${tool}`, { headers: authHeaders() })
        .then((r) => r.json())
        .then((data) => {
          if (data.status === "completed" && data.created_at) {
            setToolStates((prev) => ({
              ...prev,
              [tool]: { ...prev[tool], lastRun: data.created_at, result: data.result },
            }));
          } else if (data.status === "not_configured") {
            setToolStates((prev) => ({
              ...prev,
              [tool]: { ...prev[tool], phase: "not_configured" },
            }));
          }
        })
        .catch(() => {});
    }
  }, []);

  // Cleanup polls on unmount
  useEffect(() => {
    return () => {
      for (const key of Object.keys(pollRefs.current)) {
        const ref = pollRefs.current[key];
        if (ref) clearInterval(ref);
      }
    };
  }, []);

  const updateTool = useCallback((tool: ToolName, update: Partial<ToolState>) => {
    setToolStates((prev) => ({ ...prev, [tool]: { ...prev[tool], ...update } }));
  }, []);

  /* ── Poll for status ───────────────────────────────────────────── */

  function startPolling(tool: ToolName, run_id: number) {
    // Clear any existing poll for this tool
    if (pollRefs.current[tool]) {
      clearInterval(pollRefs.current[tool]!);
    }

    pollRefs.current[tool] = setInterval(async () => {
      try {
        const r = await fetchWithRefresh(
          `/api/tools/status?run_id=${run_id}&tool=${tool}`,
          { headers: authHeaders() },
        );
        const data = await r.json();

        if (data.status === "completed") {
          clearInterval(pollRefs.current[tool]!);
          pollRefs.current[tool] = null;
          updateTool(tool, {
            phase: "completed",
            result: data.result ?? {},
            elapsed_ms: data.elapsed_ms,
            lastRun: data.created_at ?? new Date().toISOString(),
          });
        } else if (data.status === "failed") {
          clearInterval(pollRefs.current[tool]!);
          pollRefs.current[tool] = null;
          updateTool(tool, {
            phase: "failed",
            error: data.error ?? "Workflow failed",
            elapsed_ms: data.elapsed_ms,
          });
        } else if (data.status === "running" || data.status === "in_progress") {
          updateTool(tool, { phase: "running", elapsed_ms: data.elapsed_ms });
        } else {
          updateTool(tool, { phase: "queued", elapsed_ms: data.elapsed_ms });
        }
      } catch {
        // Network error during poll — keep trying
      }
    }, 5000);
  }

  /* ── Trigger a tool ────────────────────────────────────────────── */

  async function triggerTool(tool: ToolName, body: Record<string, unknown> = {}) {
    updateTool(tool, { phase: "starting", error: undefined, result: undefined });

    try {
      const r = await fetchWithRefresh(`/api/tools/${tool}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      const data = await r.json();

      if (data.status === "not_configured") {
        updateTool(tool, { phase: "not_configured", error: data.message });
        return;
      }

      if (data.status === "queued" && data.run_id) {
        updateTool(tool, { phase: "queued", run_id: data.run_id });
        startPolling(tool, data.run_id);
        return;
      }

      if (data.status === "failed" || data.error) {
        updateTool(tool, { phase: "failed", error: data.error ?? data.detail ?? "Something went wrong" });
        return;
      }

      // Unexpected response
      updateTool(tool, { phase: "failed", error: "Unexpected response from server" });
    } catch (err) {
      updateTool(tool, {
        phase: "failed",
        error: `Network error: ${(err as Error).message}`,
      });
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  function isActive(tool: ToolName): boolean {
    const phase = toolStates[tool].phase;
    return phase === "starting" || phase === "queued" || phase === "running";
  }

  function statusLabel(tool: ToolName): string | null {
    const st = toolStates[tool];
    switch (st.phase) {
      case "starting":
        return "Starting...";
      case "queued":
        return "Queued — waiting for runner...";
      case "running":
        return `Running... (usually takes ~2 minutes)`;
      case "completed":
        return null; // show results instead
      case "failed":
        return null; // show error instead
      case "not_configured":
        return null; // show config message
      default:
        return null;
    }
  }

  function formatTimeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  /* ── Render ────────────────────────────────────────────────────── */

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.8rem", margin: 0 }}>Tools</h1>
        <p style={{ color: "var(--wp-text-dim)", marginTop: "0.4rem" }}>
          One-click utilities to generate reports, capture previews, and run checks.
          Runs are powered by GitHub Actions — results appear here when ready.
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
          {toolStates["pdf-report"].lastRun && toolStates["pdf-report"].phase === "idle" && (
            <div style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
              Last run: {formatTimeAgo(toolStates["pdf-report"].lastRun!)}
            </div>
          )}
          <div style={{ flex: 1 }} />
          <div style={{ flex: 1 }} />
          <button
            onClick={() => triggerTool("pdf-report")}
            disabled={isActive("pdf-report")}
            style={isActive("pdf-report") ? btnDisabled : btnPrimary}
          >
            {isActive("pdf-report") ? "Running..." : "Generate Report"}
          </button>
          <ToolStatusDisplay tool="pdf-report" state={toolStates["pdf-report"]} statusLabel={statusLabel("pdf-report")} runId={toolStates["pdf-report"].run_id} />
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
            style={{
              width: "100%",
              padding: "0.5rem 0.7rem",
              background: "var(--wp-dark)",
              border: "1px solid var(--wp-border)",
              borderRadius: "6px",
              color: "var(--wp-text)",
              fontSize: "0.85rem",
              maxWidth: "100%",
              boxSizing: "border-box",
            }}
          >
            <option value="instinct">Instinct</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
          {toolStates["demo-deck"].lastRun && toolStates["demo-deck"].phase === "idle" && (
            <div style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
              Last run: {formatTimeAgo(toolStates["demo-deck"].lastRun!)}
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => triggerTool("demo-deck", { target_url: deckTarget === "instinct" ? undefined : deckTarget })}
            disabled={isActive("demo-deck")}
            style={isActive("demo-deck") ? btnDisabled : btnPrimary}
          >
            {isActive("demo-deck") ? "Running..." : "Capture Preview"}
          </button>
          <ToolStatusDisplay tool="demo-deck" state={toolStates["demo-deck"]} statusLabel={statusLabel("demo-deck")} runId={toolStates["demo-deck"].run_id} />
          {/* Show pages from result */}
          {Array.isArray(toolStates["demo-deck"].result?.pages) && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: "0.5rem", marginTop: "0.5rem" }}>
              {(toolStates["demo-deck"].result.pages as Array<{ path: string; title?: string }>).map((p, i) => (
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
                  {p.title ?? p.path}
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
          {toolStates["visual-diff"].lastRun && toolStates["visual-diff"].phase === "idle" && (
            <div style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
              Last run: {formatTimeAgo(toolStates["visual-diff"].lastRun!)}
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => triggerTool("visual-diff")}
            disabled={isActive("visual-diff")}
            style={isActive("visual-diff") ? btnDisabled : btnPrimary}
          >
            {isActive("visual-diff") ? "Running..." : "Run Check"}
          </button>
          <ToolStatusDisplay tool="visual-diff" state={toolStates["visual-diff"]} statusLabel={statusLabel("visual-diff")} runId={toolStates["visual-diff"].run_id} />
          {/* Show diff results table */}
          {Array.isArray(toolStates["visual-diff"].result?.diffs) && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--wp-border)" }}>
                  <th style={{ textAlign: "left", padding: "0.4rem 0.5rem", color: "var(--wp-text-dim)" }}>Page</th>
                  <th style={{ textAlign: "right", padding: "0.4rem 0.5rem", color: "var(--wp-text-dim)" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {(toolStates["visual-diff"].result.diffs as Array<{ path: string; changed: boolean; diff_percentage?: number }>).map((d, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--wp-border)" }}>
                    <td style={{ padding: "0.4rem 0.5rem" }}>{d.path}</td>
                    <td style={{ padding: "0.4rem 0.5rem", textAlign: "right", color: !d.changed ? "var(--wp-success)" : "var(--wp-error, #c44)" }}>
                      {!d.changed ? "No changes" : `Changed — ${d.diff_percentage ?? 0}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Brief reviewer ─────────────────────────────────────────
            Moved here from the Agent fleet page on 2026-08-05. It sat there
            from 2026-08-02 and was run ZERO times in three days, on a page
            viewed 114 times, while 217,744 other events were recorded — nobody
            writes a brief on a fleet roster, and the page promises everything
            is gated and logged while this deliberately is not.

            Tools is where the comparable utilities live and get used
            (accessibility 17 runs, visual diff 16, pdf 18), and this is the
            same shape: paste something, get a deterministic verdict, nothing
            stored. The same check also runs automatically when a brief reaches
            an agent, at POST /api/admin/agents/[id]/tasks. ───────────────── */}
        <div style={cardStyle}>
          <BriefReviewPanel />
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
          {toolStates["accessibility"].lastRun && toolStates["accessibility"].phase === "idle" && (
            <div style={{ fontSize: "0.8rem", color: "var(--wp-text-dim)" }}>
              Last run: {formatTimeAgo(toolStates["accessibility"].lastRun!)}
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => triggerTool("accessibility", { paths: ["/", "/sites", "/knowledge"] })}
            disabled={isActive("accessibility")}
            style={isActive("accessibility") ? btnDisabled : btnPrimary}
          >
            {isActive("accessibility") ? "Running..." : "Run Check"}
          </button>
          <ToolStatusDisplay tool="accessibility" state={toolStates["accessibility"]} statusLabel={statusLabel("accessibility")} runId={toolStates["accessibility"].run_id} />
          {/* Show accessibility results */}
          {Array.isArray(toolStates["accessibility"].result?.results) && (
            <div style={{ marginTop: "0.5rem" }}>
              <div
                style={{
                  display: "inline-block",
                  padding: "0.5rem 1rem",
                  borderRadius: "6px",
                  fontWeight: 700,
                  fontSize: "1.3rem",
                  color:
                    (toolStates["accessibility"].result.critical as number) === 0
                      ? "var(--wp-success)"
                      : "var(--wp-error, #c44)",
                  background: "var(--wp-dark)",
                  border: "1px solid var(--wp-border)",
                  marginBottom: "0.75rem",
                }}
              >
                {toolStates["accessibility"].result.total_issues as number} issues
                {(toolStates["accessibility"].result.critical as number) > 0 &&
                  ` (${toolStates["accessibility"].result.critical} critical)`}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {(toolStates["accessibility"].result.results as Array<{ path: string; issues: number; critical: number }>).map((r, i) => (
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
                    <span style={{ fontWeight: 600, color: r.critical > 0 ? severityColors.critical : "var(--wp-success)" }}>
                      {r.path}
                    </span>
                    {" — "}
                    <span style={{ color: "var(--wp-text-dim)" }}>
                      {r.issues} issues{r.critical > 0 ? ` (${r.critical} critical)` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Status display sub-component ──────────────────────────────────── */

function ToolStatusDisplay({
  tool: _tool,
  state,
  statusLabel,
  runId,
}: {
  tool: ToolName;
  state: ToolState;
  statusLabel: string | null;
  runId?: number;
}) {
  if (state.phase === "not_configured") {
    return (
      <div style={{ fontSize: "0.85rem", color: "var(--wp-warning, #e8a838)" }}>
        Tools are being set up — contact your admin.
      </div>
    );
  }

  if (statusLabel) {
    return (
      <div style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", display: "flex", alignItems: "center" }}>
        <span
          style={{
            display: "inline-block",
            width: 16,
            height: 16,
            border: "2px solid var(--wp-border)",
            borderTopColor: "var(--wp-gold)",
            borderRadius: "50%",
            animation: "spin 0.8s linear infinite",
            marginRight: "0.5rem",
            verticalAlign: "middle",
          }}
        />
        {statusLabel}
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div style={{ fontSize: "0.85rem", color: "var(--wp-error, #c44)" }}>
        Something went wrong — try again. {state.error ? `(${state.error})` : ""}
      </div>
    );
  }

  if (state.phase === "completed") {
    const msg = typeof state.result?.message === "string"
      ? state.result.message
      : "Complete";
    return (
      <div style={{ fontSize: "0.85rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ color: "var(--wp-success)" }}>
          {msg}
          {state.elapsed_ms ? ` (${Math.round(state.elapsed_ms / 1000)}s)` : ""}
        </span>
        {runId && (
          <a
            href={`https://github.com/the-wolfpack-agency/wolfpack-apex/actions/runs/${runId}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--wp-gold)", fontSize: "0.8rem" }}
          >
            View run on GitHub Actions ↗
          </a>
        )}
      </div>
    );
  }

  return null;
}
