"use client";

/**
 * /admin/benchmark - the benchmark dashboard: the operator-facing surface that
 * turns the active-learning loop into actionable work.
 *
 * The CI sweep scores ingested scan findings against the consent-to-test corpus's
 * per-target GROUND TRUTH (see src/lib/platform-scan/benchmark/scorer.ts), trends
 * recall/precision/coverage over time, and mines two kinds of "improve the tool"
 * signals:
 *   - coverage_gap   : a labeled vuln class we MISSED -> build/fix a detector.
 *   - noise_candidate: a class firing above ground truth -> precision-tune it.
 *
 * This page reads GET /api/admin/platform-scans/benchmark and renders:
 *   1. Latest-run summary cards (recall, precision, coverage, labeled targets, errored).
 *   2. A compact trend table of recent runs (run_at + recall + precision + coverage).
 *   3. The learning-signal BACKLOG from the latest run, grouped by kind. This is
 *      the actionable output: "improve the tool" = "work this backlog".
 *   4. Explicit empty + error states - never a blank page.
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). Unauthenticated users are redirected to /login, never shown
 * a blank state. Mirrors the chrome of /admin/platform-scans + /admin/deployment.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, StatusPill, Sparkline } from "@/components/console";

// Mirrors LearningSignal in src/lib/platform-scan/benchmark/scorer.ts. `target`
// is optional on the wire so a signal mined without a single attributable target
// (or an older persisted run) still renders, never blanks.
type SignalKind = "coverage_gap" | "noise_candidate";
interface LearningSignal {
  kind: SignalKind;
  findingClass: string;
  detail: string;
  target?: string;
}

// Mirrors BenchmarkRunRow in src/lib/platform-scan/benchmark/benchmark-store.ts
// (the GET response's `runs` shape). The full `report` JSONB is available for
// drill-down but the dashboard reads the broken-out columns + signals.
interface BenchmarkRunRow {
  id: string;
  runAt: string;
  targets: number;
  labeledTargets: number;
  // null when no labeled targets in the run (NOT APPLICABLE -> render "n/a").
  recall: number | null;
  precision: number | null;
  coverageClasses: number;
  errored: number;
  report?: unknown;
  signals: LearningSignal[];
}

const SIGNAL_KINDS: SignalKind[] = ["coverage_gap", "noise_candidate"];

// ---------------------------------------------------------------------------
// "Versus the competition" wire types - mirror the GET .../benchmark/competitive
// response in src/app/api/admin/platform-scans/benchmark/competitive/route.ts.
// ---------------------------------------------------------------------------
interface RivalOnlyGap {
  findingClass: string;
  tools: string[];
}
interface ComparisonRow {
  tool: string;
  label: string;
  target: string;
  runAt: string;
  // recall/precision are null on an unlabeled target (NOT APPLICABLE -> "n/a").
  theirs: { recall: number | null; precision: number | null; findings: number };
  ours: { recall: number | null; precision: number | null; matched: string[] };
  rivalOnlyGaps: RivalOnlyGap[];
  // null when parity is NOT CLAIMABLE (unlabeled target, no run, no tools).
  parity: boolean | null;
}
interface TrendPoint {
  runAt: string;
  recall: number;
  coverageClasses: number;
}
interface ImprovementTrend {
  series: TrendPoint[];
  latestRecall: number;
  recallDelta: number;
  coverageDelta: number;
  hasPrior: boolean;
}
interface CompetitiveResponse {
  ok?: boolean;
  comparison?: ComparisonRow[];
  improvement?: ImprovementTrend;
}

// One-line, operator-facing framing per signal kind so the backlog reads as a
// to-do list, not a metric dump.
const SIGNAL_LABEL: Record<SignalKind, string> = {
  coverage_gap: "Coverage gaps",
  noise_candidate: "Noise candidates",
};
const SIGNAL_SUBTITLE: Record<SignalKind, string> = {
  coverage_gap: "Known vuln classes we missed - build or fix a detector.",
  noise_candidate: "Classes firing above ground truth - precision-tune them.",
};
const SIGNAL_COLOR: Record<SignalKind, string> = {
  coverage_gap: "var(--wp-error, #ef4444)",
  noise_candidate: "#f59e0b",
};

// "2026-06-26T..." -> a short relative-ish label, falling back to the raw value.
// Mirrors whenLabel on the platform-scans page so timestamps read the same way.
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

// recall / precision land in [0,1]; render them as whole-number percentages.
function pct(n: number | null | undefined): string {
  // A not-applicable metric (null) is rendered as an explicit "n/a", never "0%"
  // or "100%". Conflating "we measured 0" with "not measurable" is the lie the
  // adversarial audit flagged on this very dashboard.
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return `${Math.round(n * 100)}%`;
}

const cardBox = {
  flex: "1 1 9rem",
  minWidth: "9rem",
  padding: "0.85rem 1rem",
  background: "var(--wp-dark-surface, #1f1f22)",
  border: "1px solid var(--wp-dark-border, #333)",
  borderRadius: "0.5rem",
} as const;

function SummaryCard({
  testid,
  label,
  value,
  hint,
  color,
}: {
  testid: string;
  label: string;
  value: string;
  hint?: string;
  color?: string;
}) {
  return (
    <div data-testid={testid} style={cardBox}>
      <div style={{ fontSize: "0.72rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--wp-text-muted, #6b7280)" }}>
        {label}
      </div>
      <div style={{ marginTop: "0.3rem", fontSize: "1.5rem", fontWeight: 800, color: color ?? "var(--wp-text, #eee)" }}>
        {value}
      </div>
      {hint && (
        <div style={{ marginTop: "0.15rem", fontSize: "0.75rem", color: "var(--wp-text-dim, #aaa)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function SignalRow({ signal, index }: { signal: LearningSignal; index: number }) {
  return (
    <div
      data-testid={`signal-row-${signal.kind}-${index}`}
      data-kind={signal.kind}
      style={{
        padding: "0.7rem 0.9rem",
        marginBottom: "0.5rem",
        background: "var(--wp-dark-surface, #1f1f22)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: "0.45rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <code
          data-testid={`signal-class-${signal.kind}-${index}`}
          style={{ fontFamily: "monospace", fontSize: "0.83rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}
        >
          {signal.findingClass}
        </code>
        {signal.target && (
          <span
            data-testid={`signal-target-${signal.kind}-${index}`}
            title="Target this signal was mined on"
            style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--wp-gold, #f1c233)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: "0.35rem", padding: "0.1rem 0.45rem" }}
          >
            {signal.target}
          </span>
        )}
      </div>
      <div
        data-testid={`signal-detail-${signal.kind}-${index}`}
        style={{ marginTop: "0.3rem", fontSize: "0.83rem", color: "var(--wp-text-dim, #aaa)" }}
      >
        {signal.detail}
      </div>
    </div>
  );
}

function SignalGroup({ kind, signals }: { kind: SignalKind; signals: LearningSignal[] }) {
  return (
    <div data-testid={`signal-group-${kind}`} style={{ marginBottom: "1.4rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginBottom: "0.4rem", flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: "0.7rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            padding: "0.12rem 0.5rem",
            borderRadius: "0.35rem",
            color: "#0b0b0c",
            background: SIGNAL_COLOR[kind],
          }}
        >
          {SIGNAL_LABEL[kind]}
        </span>
        <span data-testid={`signal-count-${kind}`} style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
          {signals.length}
        </span>
        <span style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}>{SIGNAL_SUBTITLE[kind]}</span>
      </div>
      {signals.length === 0 ? (
        <p data-testid={`signal-group-empty-${kind}`} style={{ fontSize: "0.83rem", color: "var(--wp-text-dim, #aaa)", margin: 0 }}>
          None in the latest run.
        </p>
      ) : (
        signals.map((s, i) => <SignalRow key={`${s.findingClass}-${i}`} signal={s} index={i} />)
      )}
    </div>
  );
}

// A horizontal recall/precision bar (no charting dep - a div). `value` is 0..1,
// or null when NOT APPLICABLE (renders an empty track, never a misleading 0%/100%).
function MetricBar({
  value,
  accent,
  testId,
}: {
  value: number | null;
  accent: string;
  testId?: string;
}) {
  const widthPct =
    value === null || !Number.isFinite(value)
      ? "0%"
      : `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  return (
    <div
      data-testid={testId}
      style={{
        position: "relative",
        height: "0.55rem",
        borderRadius: 999,
        background: "var(--wp-dark-border, #242a36)",
        overflow: "hidden",
        minWidth: "3rem",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: widthPct,
          background: accent,
          borderRadius: 999,
        }}
      />
    </div>
  );
}

// One head-to-head row: a tool's recall/precision laid next to ours, with bars.
function ComparisonCard({ row, index }: { row: ComparisonRow; index: number }) {
  // Do NOT coerce null -> 0: an unknown recall must read as n/a, not "0%".
  const ourRecall = row.ours?.recall ?? null;
  const theirRecall = row.theirs?.recall ?? null;
  // "beats us" is only knowable when BOTH recalls are real numbers.
  const beatsUs =
    typeof theirRecall === "number" &&
    typeof ourRecall === "number" &&
    theirRecall > ourRecall + 1e-9;
  // parity is tri-state: true (proven), false (rival leads / we lead pending),
  // null (not claimable - unlabeled / no run). null renders as an explicit n/a.
  const parityKnown = row.parity !== null && row.parity !== undefined;
  return (
    <div
      data-testid={`competition-row-${index}`}
      data-tool={row.tool}
      data-target={row.target}
      style={{
        padding: "0.8rem 0.9rem",
        marginBottom: "0.6rem",
        background: "var(--wp-dark-surface, #1f1f22)",
        border: "1px solid var(--wp-dark-border, #333)",
        borderRadius: "0.5rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.55rem", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: "0.9rem", color: "var(--wp-text, #eee)" }}>{row.label}</span>
        <span style={{ fontSize: "0.78rem", color: "var(--wp-text-muted, #6b7280)" }}>vs us on</span>
        <code style={{ fontSize: "0.78rem", color: "var(--wp-gold, #f1c233)" }}>{row.target}</code>
        <span style={{ flex: 1 }} />
        <StatusPill
          status={
            !parityKnown ? "open" : row.parity ? "resolved" : beatsUs ? "critical" : "open"
          }
          label={
            !parityKnown
              ? "Parity n/a (unlabeled)"
              : row.parity
                ? "Parity (we match/beat)"
                : beatsUs
                  ? "Rival leads"
                  : "We lead"
          }
          testId={`competition-status-${index}`}
        />
      </div>

      {/* Recall: theirs vs ours, side by side bars. */}
      <div style={{ display: "grid", gridTemplateColumns: "5.5rem 1fr 3rem", gap: "0.5rem", alignItems: "center", marginBottom: "0.35rem" }}>
        <span style={{ fontSize: "0.75rem", color: "var(--wp-text-muted, #6b7280)" }}>{row.label} recall</span>
        <MetricBar value={row.theirs.recall} accent="var(--wp-info, #3b82f6)" testId={`competition-theirs-recall-bar-${index}`} />
        <span data-testid={`competition-theirs-recall-${index}`} style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--wp-info, #3b82f6)", textAlign: "right" }}>{pct(row.theirs.recall)}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "5.5rem 1fr 3rem", gap: "0.5rem", alignItems: "center" }}>
        <span style={{ fontSize: "0.75rem", color: "var(--wp-text-muted, #6b7280)" }}>Our recall</span>
        <MetricBar value={ourRecall} accent="var(--wp-success, #22c55e)" testId={`competition-ours-recall-bar-${index}`} />
        <span data-testid={`competition-ours-recall-${index}`} style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--wp-success, #22c55e)", textAlign: "right" }}>{pct(ourRecall)}</span>
      </div>

      {/* Rival-only gaps = our prioritized backlog for this target/tool. */}
      {row.rivalOnlyGaps.length > 0 && (
        <div data-testid={`competition-gaps-${index}`} style={{ marginTop: "0.6rem" }}>
          <div style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--wp-error, #ef4444)", marginBottom: "0.3rem" }}>
            Rival-only gaps (our backlog)
          </div>
          {row.rivalOnlyGaps.map((g, gi) => (
            <code
              key={g.findingClass}
              data-testid={`competition-gap-${index}-${gi}`}
              style={{ display: "block", fontSize: "0.8rem", color: "var(--wp-text, #eee)", marginBottom: "0.15rem" }}
            >
              {g.findingClass}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

function CompetitionSection({
  comparison,
  improvement,
}: {
  comparison: ComparisonRow[];
  improvement: ImprovementTrend | null;
}) {
  return (
    <GlassPanel
      testId="competition-section"
      title="Versus the competition"
      subtitle="OWASP ZAP + Nuclei scored against the SAME corpus, ground truth and scorer as us - head to head, plus our recall improvement over time."
      glow="gold"
      style={{ marginBottom: "2rem" }}
    >
      {/* Improvement over time tile (our recall trend sparkline + latest delta). */}
      <div data-testid="improvement-tile" style={{ marginBottom: "1.2rem" }}>
        {improvement && improvement.series.length > 0 ? (
          <MetricTile
            testId="improvement-metric"
            display={pct(improvement.latestRecall)}
            label="Our recall (latest run)"
            kicker="Improvement over time"
            accent="var(--wp-success, #22c55e)"
            delta={
              improvement.hasPrior
                ? {
                    value: Math.round(improvement.recallDelta * 100),
                    label: `${improvement.recallDelta >= 0 ? "+" : ""}${Math.round(improvement.recallDelta * 100)} pts vs prior`,
                  }
                : { value: 0, direction: "flat", label: "first run" }
            }
            sparkline={
              <Sparkline
                data={improvement.series.map((p) => p.recall)}
                accent="var(--wp-success, #22c55e)"
                area
                width={120}
                height={32}
                testId="improvement-sparkline"
              />
            }
          />
        ) : (
          <p data-testid="improvement-empty" style={{ fontSize: "0.83rem", color: "var(--wp-text-dim, #aaa)", margin: 0 }}>
            No recall trend yet - run a benchmark sweep to start the series.
          </p>
        )}
      </div>

      {/* Per-tool head-to-head comparison. */}
      {comparison.length === 0 ? (
        <p data-testid="competition-empty" style={{ fontSize: "0.83rem", color: "var(--wp-text-dim, #aaa)", margin: 0 }}>
          No competitor benchmark runs yet - run the competitive sweep (ZAP + Nuclei) to see the head-to-head.
        </p>
      ) : (
        <div data-testid="competition-list">
          {comparison.map((row, i) => (
            <ComparisonCard key={`${row.tool}:${row.target}`} row={row} index={i} />
          ))}
        </div>
      )}
    </GlassPanel>
  );
}

export default function BenchmarkDashboardPage() {
  const router = useRouter();
  const [runs, setRuns] = useState<BenchmarkRunRow[]>([]);
  const [comparison, setComparison] = useState<ComparisonRow[]>([]);
  const [improvement, setImprovement] = useState<ImprovementTrend | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/benchmark");
      if (!res.ok) throw new Error(`Failed to load benchmark runs (HTTP ${res.status})`);
      const data = (await res.json()) as { ok?: boolean; runs?: BenchmarkRunRow[] };
      setRuns(data.runs ?? []);

      // The competitive head-to-head is a SEPARATE endpoint; a failure there must
      // never blank the base dashboard, so it degrades to an explicit empty state.
      try {
        const compRes = await fetchWithRefresh("/api/admin/platform-scans/benchmark/competitive");
        if (compRes.ok) {
          const comp = (await compRes.json()) as CompetitiveResponse;
          setComparison(comp.comparison ?? []);
          setImprovement(comp.improvement ?? null);
        } else {
          setComparison([]);
          setImprovement(null);
        }
      } catch {
        setComparison([]);
        setImprovement(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Redirect unauthenticated users; never render a blank state.
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push("/login?next=/admin/benchmark");
      return;
    }
    void load();
  }, [router, load]);

  // Runs come back newest-first (listRecentBenchmarkRuns ORDER BY run_at DESC).
  const latest = runs[0] ?? null;
  const signalsByKind: Record<SignalKind, LearningSignal[]> = {
    coverage_gap: (latest?.signals ?? []).filter((s) => s.kind === "coverage_gap"),
    noise_candidate: (latest?.signals ?? []).filter((s) => s.kind === "noise_candidate"),
  };
  const totalSignals = latest?.signals?.length ?? 0;

  return (
    <div data-testid="benchmark-page" style={{ padding: "1.5rem", maxWidth: 920, margin: "0 auto", color: "var(--wp-text, #eee)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>Benchmark</h1>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="refresh-benchmark"
          disabled={loading}
          onClick={() => void load()}
          style={{
            padding: "0.4rem 0.9rem",
            borderRadius: "0.4rem",
            border: "1px solid var(--wp-gold, #f1c233)",
            background: "transparent",
            color: "var(--wp-gold, #f1c233)",
            fontWeight: 600,
            fontSize: "0.83rem",
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
        <Link href="/admin/platform-scans" data-testid="back-to-scans" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
          ← Platform scans
        </Link>
      </div>
      <p style={{ marginTop: 0, marginBottom: "1.2rem", fontSize: "0.9rem", color: "var(--wp-text-muted, #6b7280)" }}>
        Recall, precision and coverage scored against the consent-to-test corpus over time, plus the live learning-signal backlog the sweep mined. Working this backlog is how the tool improves.
      </p>

      {loading ? (
        <p data-testid="benchmark-loading" style={{ color: "var(--wp-text-dim, #aaa)" }}>Loading…</p>
      ) : error ? (
        <p data-testid="benchmark-error" style={{ color: "var(--wp-error, #ef4444)" }}>{error}</p>
      ) : runs.length === 0 || !latest ? (
        <p data-testid="benchmark-empty" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          No benchmark runs yet - trigger a sweep to score the corpus and mine the learning-signal backlog.
        </p>
      ) : (
        <>
          {/* 1. Latest-run summary cards. */}
          <div data-testid="benchmark-summary" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <SummaryCard
              testid="summary-recall"
              label="Recall"
              value={pct(latest.recall)}
              hint="of ground-truth classes caught"
              color="var(--wp-success, #22c55e)"
            />
            <SummaryCard
              testid="summary-precision"
              label="Precision"
              value={pct(latest.precision)}
              hint="of labeled-target reports that hit"
              color="var(--wp-gold, #f1c233)"
            />
            <SummaryCard
              testid="summary-coverage"
              label="Coverage classes"
              value={String(latest.coverageClasses)}
              hint="distinct classes seen"
            />
            <SummaryCard
              testid="summary-labeled"
              label="Labeled targets"
              value={String(latest.labeledTargets)}
              hint={`of ${latest.targets} scanned`}
            />
            <SummaryCard
              testid="summary-errored"
              label="Errored"
              value={String(latest.errored)}
              hint="targets that could not be scanned"
              color={latest.errored > 0 ? "var(--wp-error, #ef4444)" : undefined}
            />
          </div>
          <p data-testid="latest-run-when" style={{ marginTop: 0, marginBottom: "1.6rem", fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}>
            Latest run <time dateTime={latest.runAt} title={latest.runAt}>{whenLabel(latest.runAt)}</time>
            {latest.labeledTargets === 0 && " · no labeled targets yet - recall/precision are not yet trustworthy"}
          </p>

          {/* 1b. Versus the competition: ZAP + Nuclei head-to-head + our improvement. */}
          <CompetitionSection comparison={comparison} improvement={improvement} />

          {/* 3. Learning-signal backlog from the latest run, grouped by kind. */}
          <div data-testid="benchmark-backlog" style={{ marginBottom: "2rem" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginBottom: "0.7rem", flexWrap: "wrap" }}>
              <h2 style={{ fontSize: "1rem", color: "var(--wp-gold, #f1c233)", margin: 0 }}>Learning-signal backlog</h2>
              <span data-testid="backlog-total" style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #6b7280)" }}>
                {totalSignals} signal{totalSignals === 1 ? "" : "s"} from the latest run
              </span>
            </div>
            {totalSignals === 0 ? (
              <p data-testid="backlog-empty" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
                No learning signals in the latest run - nothing to work right now. Clean recall + precision on the labeled corpus.
              </p>
            ) : (
              SIGNAL_KINDS.map((kind) => (
                <SignalGroup key={kind} kind={kind} signals={signalsByKind[kind]} />
              ))
            )}
          </div>

          {/* 2. Trend table of recent runs (run_at + recall + precision + coverage). */}
          <div data-testid="benchmark-trend">
            <h2 style={{ fontSize: "1rem", color: "var(--wp-gold, #f1c233)", marginBottom: "0.6rem" }}>Trend</h2>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.83rem" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--wp-text-muted, #6b7280)" }}>
                    <th style={{ padding: "0.45rem 0.6rem", fontWeight: 600 }}>Run</th>
                    <th style={{ padding: "0.45rem 0.6rem", fontWeight: 600 }}>Recall</th>
                    <th style={{ padding: "0.45rem 0.6rem", fontWeight: 600 }}>Precision</th>
                    <th style={{ padding: "0.45rem 0.6rem", fontWeight: 600 }}>Coverage</th>
                    <th style={{ padding: "0.45rem 0.6rem", fontWeight: 600 }}>Labeled</th>
                    <th style={{ padding: "0.45rem 0.6rem", fontWeight: 600 }}>Errored</th>
                    <th style={{ padding: "0.45rem 0.6rem", fontWeight: 600 }}>Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr
                      key={r.id}
                      data-testid={`trend-row-${r.id}`}
                      style={{ borderTop: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)" }}
                    >
                      <td style={{ padding: "0.45rem 0.6rem", color: "var(--wp-text-dim, #aaa)" }}>
                        <time dateTime={r.runAt} title={r.runAt}>{whenLabel(r.runAt)}</time>
                      </td>
                      <td style={{ padding: "0.45rem 0.6rem", fontWeight: 600, color: "var(--wp-success, #22c55e)" }}>{pct(r.recall)}</td>
                      <td style={{ padding: "0.45rem 0.6rem", fontWeight: 600, color: "var(--wp-gold, #f1c233)" }}>{pct(r.precision)}</td>
                      <td style={{ padding: "0.45rem 0.6rem" }}>{r.coverageClasses}</td>
                      <td style={{ padding: "0.45rem 0.6rem" }}>{r.labeledTargets}</td>
                      <td style={{ padding: "0.45rem 0.6rem", color: r.errored > 0 ? "var(--wp-error, #ef4444)" : "var(--wp-text-dim, #aaa)" }}>{r.errored}</td>
                      <td style={{ padding: "0.45rem 0.6rem" }}>{r.signals?.length ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
