"use client";

/**
 * /admin/platform-scans - the SCAN COMMAND CENTER.
 *
 * Flagship client-facing "view the results" surface for the platform-scan agent.
 * An agent crawls a target platform's routes/journeys and surfaces findings:
 * bugs, UX gaps, broken journeys, security, and performance issues, each with a
 * severity. Findings are gated into the learning loop. A human reviews them here:
 * run a fresh scan, then acknowledge or resolve each open finding (decided rows
 * drop out of the open list in place, like the agent approvals queue).
 *
 * Presentation is the dark-glass command-center kit (@/components/console):
 * GlassPanel surfaces, MetricTile hero row with count-up + sparklines, StatusPill
 * severity vocabulary, a div-built severity-distribution bar (no charting dep),
 * SectionHeader treatments, and ConsoleGrid staggered reveal. Data wiring,
 * controls, and states are preserved exactly - same endpoints, same handlers.
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). POST bodies use jsonHeaders(). Unauthenticated visitors are
 * redirected to /login (never a blank surface).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, getInstinctToken, jsonHeaders } from "@/lib/client-auth";
import {
  GlassPanel,
  MetricTile,
  StatusPill,
  Sparkline,
  SectionHeader,
  ConsoleGrid,
  type SeverityTone,
} from "@/components/console";
import { TESTING_TAXONOMY } from "@/lib/platform-scan/testing-taxonomy";

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

// Severity -> the console kit's tone vocabulary. The kit collapses high into the
// error tone; we keep high VISUALLY distinct (warning/amber) here so the four
// severities read as four bands, matching the prior design + the distribution bar.
const SEVERITY_TONE: Record<Severity, SeverityTone> = {
  critical: "error",
  high: "warning",
  medium: "gold",
  low: "neutral",
};

// CSS var per severity for the distribution bar + sparkline accents (token-based;
// the tone vocabulary backs each one so colors stay single-sourced).
const SEVERITY_VAR: Record<Severity, string> = {
  critical: "var(--wp-error, #ef4444)",
  high: "var(--wp-warning, #f59e0b)",
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

type UxGrade = "A" | "B" | "C" | "D" | "F";

// The UX/accessibility posture grade the summary route computes from open ux_gap
// findings. Optional on the wire so an older summary response (pre-uxPosture)
// renders the explicit "No UX scan yet" empty state, never a blank.
interface UxPosture {
  grade: UxGrade;
  ux: number;
  a11y: number;
  total: number;
  bySeverity: { high: number; medium: number; low: number };
  score: number;
}

// Grade -> tone. A success, B/C gold, D warning, F error - same tone vocabulary
// the severity pills use, so the headline reads consistently.
const UX_GRADE_TONE: Record<UxGrade, SeverityTone> = {
  A: "success",
  B: "gold",
  C: "gold",
  D: "warning",
  F: "error",
};

const UX_GRADE_LABEL: Record<UxGrade, string> = {
  A: "No UX or accessibility gaps",
  B: "Minor usability issues",
  C: "Usability gaps to address",
  D: "A blocking UX/a11y gap present",
  F: "Multiple blocking UX/a11y gaps",
};

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
// list to every severity - no data is lost, low findings stay reachable.
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

// Horizontal stacked severity-distribution bar built from divs + token colors.
// No charting dependency. Zero total renders an explicit empty band.
function SeverityDistributionBar({ summary }: { summary: FindingsSummary }) {
  const total = SEVERITY_ORDER.reduce((n, s) => n + summary.bySeverity[s], 0);
  return (
    <div data-testid="severity-distribution">
      <div
        style={{
          display: "flex",
          width: "100%",
          height: 14,
          borderRadius: 999,
          overflow: "hidden",
          background: "var(--wp-dark-surface, #1f1f22)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        {total === 0 ? (
          <div
            data-testid="severity-distribution-empty"
            style={{ flex: 1, background: "var(--wp-dark-surface, #1f1f22)" }}
          />
        ) : (
          SEVERITY_ORDER.map((sev) => {
            const count = summary.bySeverity[sev];
            if (count === 0) return null;
            const pct = (count / total) * 100;
            return (
              <div
                key={sev}
                data-testid={`severity-distribution-${sev}`}
                title={`${count} ${sev} (${pct.toFixed(0)}%)`}
                style={{ width: `${pct}%`, background: SEVERITY_VAR[sev] }}
              />
            );
          })
        )}
      </div>
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "0.6rem" }}>
        {SEVERITY_ORDER.map((sev) => (
          <span
            key={sev}
            data-testid={`sev-count-${sev}`}
            style={{ display: "inline-flex", alignItems: "center", opacity: summary.bySeverity[sev] === 0 ? 0.45 : 1 }}
          >
            <StatusPill
              status={sev}
              tone={SEVERITY_TONE[sev]}
              label={`${sev} ${summary.bySeverity[sev]}`}
            />
          </span>
        ))}
      </div>
    </div>
  );
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
        borderLeft: `3px solid ${SEVERITY_VAR[finding.severity]}`,
        borderRadius: "0.5rem",
        marginBottom: "0.6rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <span data-testid={`finding-severity-${finding.id}`}>
          <StatusPill status={finding.severity} tone={SEVERITY_TONE[finding.severity]} size="md" />
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

// At-a-glance UX/accessibility posture headline. Renders the graded pill + the
// ux/a11y split, or an explicit empty state when no UX posture has been computed
// (absent on the wire / no findings yet) - never a blank.
//
// Drill-down: the grade alone ("B / Minor usability nits") is not explainable on
// its own, so this component surfaces the ACTUAL finding(s) behind the grade.
// `uxFindings` are the ux_gap findings already loaded into the open list - when
// any are loaded it lists them inline (title + detail), honestly showing the real
// data. When the grade reports nits but none are currently loaded (the list is
// narrowed to the actionable band, hiding lower-severity UX nits), it offers a
// "View the N nit(s)" affordance that widens + filters the list so they appear -
// nothing fabricated, nothing hidden.
function UxPostureBadge({
  posture,
  uxFindings,
  onReveal,
}: {
  posture: UxPosture | null;
  uxFindings: ScanFindingRow[];
  onReveal: () => void;
}) {
  if (!posture) {
    return (
      <div
        data-testid="ux-posture-empty"
        style={{
          padding: "0.7rem 1rem",
          borderRadius: "0.5rem",
          fontSize: "0.85rem",
          color: "var(--wp-text-dim, #aaa)",
          background: "var(--wp-dark-surface, #1f1f22)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        No UX scan yet - run a scan to grade this platform&apos;s usability and accessibility.
      </div>
    );
  }

  // Number of UX/a11y gaps behind the grade that are NOT currently loaded into
  // the open list (the actionable-band default can hide lower-severity nits).
  // When > 0 we offer a reveal affordance instead of pretending the list is
  // complete.
  const loadedCount = uxFindings.length;
  const hasNits = posture.total > 0;

  return (
    <div data-testid="ux-posture" data-grade={posture.grade} style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <span data-testid="ux-posture-grade">
          <StatusPill status={posture.grade} tone={UX_GRADE_TONE[posture.grade]} size="md" label={`Grade ${posture.grade}`} />
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", minWidth: 0 }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
            UX posture: {posture.grade}
          </span>
          <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim, #aaa)" }}>
            {UX_GRADE_LABEL[posture.grade]}
          </span>
        </div>
        <span style={{ flex: 1, minWidth: 0 }} />
        <span data-testid="ux-posture-split" style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)", whiteSpace: "nowrap" }}>
          {posture.ux} UX · {posture.a11y} accessibility · {posture.total} total
        </span>
      </div>

      {/* Drill-down: the actual finding(s) behind the grade. */}
      {hasNits && (
        <div data-testid="ux-posture-drilldown" style={{ marginTop: "0.7rem" }}>
          {loadedCount > 0 ? (
            <div data-testid="ux-posture-findings" style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {uxFindings.map((f) => (
                <div
                  key={f.id}
                  data-testid={`ux-posture-finding-${f.id}`}
                  style={{
                    padding: "0.5rem 0.7rem",
                    borderRadius: "0.45rem",
                    background: "var(--wp-dark-surface, #1f1f22)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    borderLeft: `3px solid ${SEVERITY_VAR[f.severity]}`,
                    minWidth: 0,
                    overflowWrap: "anywhere",
                  }}
                >
                  <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>{f.title}</div>
                  <div style={{ marginTop: "0.15rem", fontSize: "0.78rem", color: "var(--wp-text-dim, #aaa)" }}>{f.detail}</div>
                </div>
              ))}
            </div>
          ) : (
            <button
              type="button"
              data-testid="ux-posture-reveal"
              onClick={onReveal}
              style={{
                fontSize: "0.78rem",
                fontWeight: 600,
                cursor: "pointer",
                color: "var(--wp-gold, #f1c233)",
                background: "transparent",
                border: "1px solid var(--wp-gold, #f1c233)",
                borderRadius: "0.4rem",
                padding: "0.3rem 0.7rem",
              }}
            >
              View the {posture.total} {posture.total === 1 ? "nit" : "nits"} behind this grade
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// "What we tested" - the client-facing validation-coverage map. Renders the
// testing-taxonomy (pure data) as a tidy three-column grid: Area | Type of
// testing | What is validated. Plain language, confident, true, and contains
// NO tool or brand names (enforced by the taxonomy test). It maps the TYPES of
// testing the platform performs to the system areas so a client understands how
// comprehensive the scan that just ran really is. Built on the console kit.
function ValidationCoverage() {
  // Three-column track on desktop; the leftmost two columns hug their content
  // and the "validates" column takes the rest. minWidth:0 on every cell so long
  // copy wraps instead of forcing horizontal overflow. On narrow viewports the
  // header row hides and each row stacks (label chips above the prose).
  const rowGrid = {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: "0.35rem 1rem",
    alignItems: "start",
  } as const;

  return (
    <GlassPanel
      testId="validation-coverage"
      title="What we tested"
      subtitle="The kinds of testing this scan applies, the system areas they cover, and what each one validates."
      style={{ marginBottom: "1.25rem" }}
    >
      {/* Responsive promotion to a 3-column grid at >=720px. Scoped to this
          page's class so it touches nothing in the shared kit; below the
          breakpoint each row stays single-column and stacks cleanly. The header
          row hides on narrow widths since the stacked rows are self-evident. */}
      <style>{`
        @media (min-width: 720px) {
          .wp-coverage-grid {
            grid-template-columns: minmax(8rem, 0.8fr) minmax(8rem, 0.9fr) minmax(0, 1.6fr) !important;
          }
        }
        @media (max-width: 719px) {
          [data-testid="validation-coverage-header"] { display: none !important; }
          /* Run-scan controls stack + go full-width on phones so no select or
             button overflows or gets cut off on the right. */
          .wp-scan-field { flex: 1 1 100% !important; }
          .wp-scan-select { flex: 1 1 auto !important; }
          .wp-scan-field[style*="margin-left: auto"],
          .wp-scan-field { margin-left: 0 !important; }
          .wp-scan-run { flex: 1 1 100% !important; width: 100% !important; }
        }
      `}</style>
      {/* Column header - sm+ only; on phones each row self-labels. */}
      <div
        data-testid="validation-coverage-header"
        className="wp-coverage-grid"
        style={{
          ...rowGrid,
          paddingBottom: "0.6rem",
          marginBottom: "0.6rem",
          borderBottom: "1px solid var(--wp-dark-border, #333)",
          fontSize: "0.72rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--wp-text-muted, #6b7280)",
        }}
      >
        <span style={{ minWidth: 0 }}>Area</span>
        <span style={{ minWidth: 0 }}>Type of testing</span>
        <span style={{ minWidth: 0 }}>What is validated</span>
      </div>

      <div data-testid="validation-coverage-rows">
        {TESTING_TAXONOMY.map((entry) => (
          <div
            key={entry.area}
            data-testid={`coverage-row-${entry.area}`}
            className="wp-coverage-grid"
            style={{
              ...rowGrid,
              padding: "0.55rem 0",
              borderBottom: "1px solid var(--wp-dark-border, #2a2a2e)",
            }}
          >
            <span
              style={{
                minWidth: 0,
                overflowWrap: "anywhere",
                fontSize: "0.85rem",
                fontWeight: 700,
                color: "var(--wp-text, #eee)",
              }}
            >
              {entry.area}
            </span>
            <span
              style={{
                minWidth: 0,
                overflowWrap: "anywhere",
                fontSize: "0.82rem",
                color: "var(--wp-gold, #f1c233)",
              }}
            >
              {entry.testingType}
            </span>
            <span
              style={{
                minWidth: 0,
                overflowWrap: "anywhere",
                fontSize: "0.82rem",
                lineHeight: 1.5,
                color: "var(--wp-text-dim, #aaa)",
              }}
            >
              {entry.validates}
            </span>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}

export default function PlatformScansPage() {
  // Auth gate: redirect unauthenticated visitors instead of rendering a blank
  // surface. Mirrors the dashboard/goals guard. Until the check runs, hold the
  // page back so we never flash an empty command center to a logged-out user.
  const [authed, setAuthed] = useState<boolean | null>(null);

  const [findings, setFindings] = useState<ScanFindingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [findingsSummary, setFindingsSummary] = useState<FindingsSummary>(EMPTY_SUMMARY);
  const [scanHistory, setScanHistory] = useState<ScanHistoryRow[]>([]);
  const [uxPosture, setUxPosture] = useState<UxPosture | null>(null);
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

  // Fire-once guard for the "results viewed" engagement event: the summary
  // reloads on every filter change, so a ref keeps the view event to a single
  // emission per mount (re-renders / re-fetches never double-fire). Never set
  // before the auth-redirect guard passes, so a logged-out visitor emits nothing.
  const resultsViewedRef = useRef(false);
  // Latest onboarded-target count, mirrored into a ref so the results-viewed
  // event can read it without making loadSummary depend on (and re-fire with)
  // the targets state.
  const targetsCountRef = useRef(0);

  const selectedTarget = targets.find((t) => t.platform === selectedPlatform) ?? null;
  const allSeverities = severities.length === 0;
  // The ux_gap findings currently loaded in the open list (covers both general
  // UX and accessibility gaps - a11y is a ux_gap with an "Accessibility:" title).
  // Drives the posture drill-down: when any are loaded we show the REAL finding;
  // otherwise the badge offers a reveal that widens the list so they load.
  const uxFindings = findings.filter((f) => f.category === "ux_gap");

  // Best-effort engagement analytics: a viewed/toggle event is a learning signal
  // (the same loop drift + procedure learning consume). A failure must never
  // break the surface, so the POST is fire-and-forget. /api/analytics is the
  // observability beacon; fetchWithRefresh is the repo's client analytics path.
  const trackEngagement = useCallback(
    (event: string, metadata: Record<string, unknown>) => {
      void fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ event, metadata }),
      }).catch(() => undefined);
    },
    [],
  );

  // Toggle the severity band the LIST is narrowed to and record the toggle as an
  // engagement signal. "actionable" = critical+high; "all" = every severity.
  const setSeverityBand = useCallback(
    (band: "actionable" | "all") => {
      setSeverities(band === "actionable" ? ACTIONABLE_SEVERITIES : []);
      trackEngagement("platform.severity_filter_toggled", {
        band,
        platform: filterPlatform || "all",
      });
    },
    [trackEngagement, filterPlatform],
  );

  useEffect(() => {
    const token = getInstinctToken();
    if (!token) {
      if (typeof window !== "undefined") {
        window.location.href = "/login?next=/admin/platform-scans";
      }
      setAuthed(false);
      return;
    }
    setAuthed(true);
  }, []);

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
      const data = (await res.json()) as { summary?: FindingsSummary; scans?: ScanHistoryRow[]; uxPosture?: UxPosture };
      const loadedSummary = data.summary ?? EMPTY_SUMMARY;
      setFindingsSummary(loadedSummary);
      setScanHistory(data.scans ?? []);
      // null when the route omits it (older deploy) so the badge shows its empty
      // state rather than a stale/blank grade.
      setUxPosture(data.uxPosture ?? null);
      // Fire the "results viewed" engagement event ONCE, after the first
      // successful summary load, with the loaded rollup. The ref keeps re-fetches
      // (filter changes, post-scan reloads) from re-firing it.
      if (!resultsViewedRef.current) {
        resultsViewedRef.current = true;
        trackEngagement("platform.results_viewed", {
          open_total: loadedSummary.total,
          critical: loadedSummary.bySeverity.critical,
          high: loadedSummary.bySeverity.high,
          targets: targetsCountRef.current,
        });
      }
    } catch {
      /* rollup is contextual; the findings list still renders without it. */
    }
  }, [trackEngagement]);

  const loadTargets = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/targets");
      if (!res.ok) return;
      const data = (await res.json()) as { targets?: ScanTarget[] };
      const list = data.targets ?? [];
      setTargets(list);
      targetsCountRef.current = list.length;
      if (list.length > 0) setSelectedPlatform((p) => p || list[0].platform);
    } catch {
      /* targets are a convenience; a failure leaves the selector empty but the
         page still loads findings. */
    }
  }, []);

  useEffect(() => {
    if (authed !== true) return;
    void loadTargets();
  }, [authed, loadTargets]);

  // Load findings on mount and whenever the platform OR severity filter changes
  // (filter "" means all platforms; empty severities means all severities). The
  // summary always reloads with the FULL counts regardless of the list filter.
  useEffect(() => {
    if (authed !== true) return;
    void load(filterPlatform || undefined, severities);
    void loadSummary(filterPlatform || undefined);
  }, [authed, filterPlatform, severities, load, loadSummary]);

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
    // Decided findings leave the open list - drop them in place + refresh the
    // rollup so the severity/category counts track the open queue.
    setFindings((prev) => prev.filter((f) => f.id !== id));
    void loadSummary(filterPlatform || undefined);
  }, [loadSummary, filterPlatform]);

  // Bulk-triage every OPEN finding matching the ACTIVE severity + platform
  // filter - what the operator currently sees, nothing hidden. Resolve is guarded
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

  // Hold the page back until the auth check has run so a logged-out visitor never
  // flashes the command center before the redirect fires.
  if (authed !== true) {
    return (
      <div
        data-testid="platform-scans-auth-pending"
        style={{ padding: "1.5rem", color: "var(--wp-text-dim, #aaa)" }}
      >
        Loading…
      </div>
    );
  }

  // Most-recent run drives the "last scan" tile + coverage line.
  const latestScan = scanHistory[0] ?? null;
  // Finding-count trend over time (oldest -> newest) for the hero sparkline.
  const findingTrend = [...scanHistory].reverse().map((s) => s.findingCount);
  const criticalTrend = [...scanHistory].reverse().map((s) => s.criticalCount);
  const platformsScanned = new Set(scanHistory.map((s) => s.platform)).size;

  // Control style shared by the selects.
  const ctrl = {
    padding: "0.4rem 0.6rem",
    borderRadius: "0.4rem",
    fontSize: "0.85rem",
    background: "var(--wp-dark-surface, #1f1f22)",
    color: "var(--wp-text, #eee)",
    border: "1px solid var(--wp-dark-border, #333)",
  } as const;

  const categoryLine = Object.entries(findingsSummary.byCategory)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${CATEGORY_LABEL[cat as Category] ?? cat} ${n}`)
    .join(" · ");

  // Lower-severity findings hidden by the active band. Surfaced as a "show all"
  // affordance so nothing is hidden silently - the data is one click away.
  const hiddenCount = allSeverities
    ? 0
    : SEVERITY_ORDER.filter((s) => !severities.includes(s)).reduce(
        (n, s) => n + findingsSummary.bySeverity[s],
        0,
      );

  const chipStyle = (active: boolean) =>
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
      data-testid="platform-scans-page"
      style={{ padding: "1.5rem", maxWidth: 1080, margin: "0 auto", color: "var(--wp-text, #eee)" }}
    >
      <SectionHeader
        as="h1"
        eyebrow="Scan command center"
        title="Platform scans"
        subtitle="An agent crawls a target platform's journeys and surfaces bugs and use-case gaps; each finding is gated into the learning loop."
        actions={
          <Link href="/admin/agents" data-testid="back-to-agents" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
            ← Agents
          </Link>
        }
      />

      {/* Hero metrics row */}
      <ConsoleGrid minColWidth={180} style={{ marginBottom: "1.25rem" }} testId="hero-metrics">
        <GlassPanel padded testId="metric-panel-targets">
          <MetricTile
            value={targets.length}
            label="Targets onboarded"
            kicker={platformsScanned > 0 ? `${platformsScanned} scanned` : "Scan a target"}
            accent="var(--wp-gold, #f1c233)"
            testId="metric-targets"
          />
        </GlassPanel>
        <GlassPanel padded testId="metric-panel-open">
          <MetricTile
            value={findingsSummary.total}
            label="Open findings"
            kicker="Across all severities"
            sparkline={findingTrend.length > 1 ? <Sparkline data={findingTrend} accent="var(--wp-info, #3b82f6)" area ariaLabel="open findings trend" /> : undefined}
            testId="metric-open"
          />
        </GlassPanel>
        <GlassPanel padded glow={findingsSummary.bySeverity.critical > 0 ? "gold" : "none"} testId="metric-panel-critical">
          <MetricTile
            value={findingsSummary.bySeverity.critical}
            label="Critical"
            kicker="Highest priority"
            accent={SEVERITY_VAR.critical}
            sparkline={criticalTrend.length > 1 ? <Sparkline data={criticalTrend} accent={SEVERITY_VAR.critical} ariaLabel="critical trend" /> : undefined}
            testId="metric-critical"
          />
        </GlassPanel>
        <GlassPanel padded testId="metric-panel-high">
          <MetricTile
            value={findingsSummary.bySeverity.high}
            label="High"
            kicker="Actionable now"
            accent={SEVERITY_VAR.high}
            testId="metric-high"
          />
        </GlassPanel>
        <GlassPanel padded testId="metric-panel-grade">
          <MetricTile
            display={uxPosture ? uxPosture.grade : "-"}
            label="UX/a11y grade"
            kicker={uxPosture ? UX_GRADE_LABEL[uxPosture.grade] : "No UX scan yet"}
            accent={uxPosture ? `var(--wp-${UX_GRADE_TONE[uxPosture.grade] === "neutral" ? "text" : UX_GRADE_TONE[uxPosture.grade]})` : undefined}
            testId="metric-grade"
          />
        </GlassPanel>
        <GlassPanel padded testId="metric-panel-last-scan">
          <MetricTile
            display={latestScan ? whenLabel(latestScan.createdAt) : "Never"}
            label="Last scan"
            kicker={latestScan ? latestScan.platform : "No scans yet"}
            testId="metric-last-scan"
          />
        </GlassPanel>
      </ConsoleGrid>

      {/* Run-scan control deck */}
      <GlassPanel
        testId="scan-controls-panel"
        glow="gold"
        title="Run a scan"
        subtitle="Pick a target and how to crawl it, then launch."
        style={{ marginBottom: "1.25rem" }}
      >
        {/* The control row wraps and, on mobile, each field + the run button go
            full-width so nothing overflows or gets cut off. The .wp-scan-* class
            hooks drive the mobile rules in the page's scoped style block. */}
        <div
          data-testid="scan-controls"
          className="wp-scan-controls"
          style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}
        >
          <div className="wp-scan-field" style={{ display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 0 }}>
            <label htmlFor="platform-select" style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)", whiteSpace: "nowrap" }}>Platform</label>
            <select
              id="platform-select"
              data-testid="platform-select"
              className="wp-scan-select"
              value={selectedPlatform}
              onChange={(e) => { setSelectedPlatform(e.target.value); setMode("http"); }}
              style={{ ...ctrl, minWidth: 0, maxWidth: "100%" }}
            >
              {targets.length === 0 && <option value="">(no targets)</option>}
              {targets.map((t) => (
                <option key={t.platform} value={t.platform}>{t.platform}</option>
              ))}
            </select>
          </div>
          <div className="wp-scan-field" style={{ display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 0 }}>
            <label htmlFor="mode-select" style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)", whiteSpace: "nowrap" }}>Mode</label>
            <select
              id="mode-select"
              data-testid="mode-select"
              className="wp-scan-select"
              value={mode}
              onChange={(e) => setMode(e.target.value as ScanMode)}
              title={selectedTarget?.hasStatic ? "How to scan" : "Source scan not configured for this platform"}
              style={{ ...ctrl, minWidth: 0, maxWidth: "100%" }}
            >
              <option value="http">Live crawl (HTTP){selectedTarget?.hasLogin ? " · authenticated" : ""}</option>
              <option value="static" disabled={!selectedTarget?.hasStatic}>Source scan</option>
              <option value="api" disabled={!selectedTarget?.hasApi}>API contract</option>
            </select>
          </div>
          <button
            type="button"
            data-testid="run-scan"
            className="wp-scan-run"
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
              whiteSpace: "nowrap",
            }}
          >
            {scanning ? `Scanning ${selectedPlatform}…` : "Run scan"}
          </button>
          {summary && (
            <span data-testid="scan-summary" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)", minWidth: 0, overflowWrap: "anywhere" }}>
              {summary.platform} ({summary.mode === "static" ? "source" : "HTTP"}):{" "}
              {summary.routes !== null ? `${summary.routes} route${summary.routes === 1 ? "" : "s"}, ` : ""}
              {summary.findings} finding{summary.findings === 1 ? "" : "s"}, {summary.critical} critical
            </span>
          )}
          {scanError && (
            <span data-testid="scan-error" style={{ fontSize: "0.85rem", color: "var(--wp-error, #ef4444)", minWidth: 0, overflowWrap: "anywhere" }}>
              {scanError}
            </span>
          )}
          {targets.length > 1 && (
            <div className="wp-scan-field" style={{ display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 0, marginLeft: "auto" }}>
              <label htmlFor="filter-platform" style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)", whiteSpace: "nowrap" }}>Showing</label>
              <select
                id="filter-platform"
                data-testid="filter-platform"
                className="wp-scan-select"
                value={filterPlatform}
                onChange={(e) => setFilterPlatform(e.target.value)}
                style={{ ...ctrl, minWidth: 0, maxWidth: "100%" }}
              >
                <option value="">All platforms</option>
                {targets.map((t) => (
                  <option key={t.platform} value={t.platform}>{t.platform}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </GlassPanel>

      {/* Posture + distribution */}
      <ConsoleGrid minColWidth={320} style={{ marginBottom: "1.25rem" }} testId="posture-grid">
        <GlassPanel testId="ux-posture-panel" title="UX / accessibility posture">
          <UxPostureBadge
            posture={uxPosture}
            uxFindings={uxFindings}
            onReveal={() => setSeverityBand("all")}
          />
        </GlassPanel>
        <GlassPanel
          testId="severity-distribution-panel"
          title="Severity distribution"
          subtitle={
            <span data-testid="findings-summary">
              <span data-testid="open-total">{findingsSummary.total} open</span>
              {categoryLine && (
                <>
                  {" · "}
                  <span data-testid="category-breakdown">{categoryLine}</span>
                </>
              )}
            </span>
          }
        >
          <SeverityDistributionBar summary={findingsSummary} />
        </GlassPanel>
      </ConsoleGrid>

      {latestScan && (
        <div style={{ marginBottom: "1.25rem" }}>
          <CoverageHealth scan={latestScan} />
        </div>
      )}

      {/* Findings result grid */}
      <GlassPanel
        testId="findings-panel"
        title="Findings"
        subtitle="The open queue. Acknowledge or resolve to clear a row; decided rows leave the list."
        style={{ marginBottom: "1.25rem" }}
        actions={
          <div
            data-testid="severity-filter"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              // Always wrap; never clip the rightmost control. flex:1 1 100%
              // makes this controls row claim a full line of its own in the
              // GlassPanel header so it never squeezes the "Findings" title +
              // subtitle to near-zero width (the one-word-per-line bug). On
              // mobile the chips + buttons stack onto multiple lines.
              flexWrap: "wrap",
              flex: "1 1 100%",
              minWidth: 0,
              maxWidth: "100%",
            }}
          >
            <span style={{ fontSize: "0.78rem", color: "var(--wp-text-muted, #6b7280)" }}>Showing severity</span>
            <button
              type="button"
              data-testid="severity-chip-actionable"
              aria-pressed={!allSeverities}
              onClick={() => setSeverityBand("actionable")}
              style={chipStyle(!allSeverities)}
            >
              Actionable (critical + high)
            </button>
            <button
              type="button"
              data-testid="severity-chip-all"
              aria-pressed={allSeverities}
              onClick={() => setSeverityBand("all")}
              style={chipStyle(allSeverities)}
            >
              All severities
            </button>
            {hiddenCount > 0 && (
              <button
                type="button"
                data-testid="show-all-severities"
                onClick={() => setSeverityBand("all")}
                style={{ fontSize: "0.78rem", color: "var(--wp-gold, #f1c233)", background: "transparent", border: "none", cursor: "pointer", padding: "0.3rem 0.2rem" }}
              >
                +{hiddenCount} lower-severity hidden - show all
              </button>
            )}
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
          </div>
        }
      >
        {bulkError && (
          <div data-testid="bulk-error" style={{ marginBottom: "0.75rem", fontSize: "0.8rem", color: "var(--wp-error, #ef4444)" }}>
            {bulkError}
          </div>
        )}
        {loading ? (
          <p data-testid="findings-loading" style={{ color: "var(--wp-text-dim, #aaa)", margin: 0 }}>Loading…</p>
        ) : error ? (
          <p data-testid="findings-error" style={{ color: "var(--wp-error, #ef4444)", margin: 0 }}>{error}</p>
        ) : findings.length === 0 ? (
          <p data-testid="findings-empty" style={{ color: "var(--wp-text-dim, #aaa)", margin: 0 }}>
            No open findings. Run a scan to check the platform.
          </p>
        ) : (
          <div data-testid="findings-list">
            {findings.map((f) => (
              <FindingRow key={f.id} finding={f} onDecide={decide} />
            ))}
          </div>
        )}
      </GlassPanel>

      {/* What we tested - the client-facing validation-coverage map. */}
      <ValidationCoverage />

      {/* Scan history */}
      <GlassPanel testId="scan-history" title="Scan history">
        {scanHistory.length === 0 ? (
          <p data-testid="scan-history-empty" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)", margin: 0 }}>
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
      </GlassPanel>
    </div>
  );
}
