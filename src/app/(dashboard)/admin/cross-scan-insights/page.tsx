"use client";

/**
 * /admin/cross-scan-insights - the Cross-scan intelligence console.
 *
 * The cross-scan engine (src/lib/platform-scan/insights/*) is the moat: it reads
 * the WHOLE finding corpus across every modality (frontend / backend / db /
 * security / ux / perf) AND across time (resolved->reopened) and folds it into
 * higher-order insights no single-layer scanner can produce. This page makes that
 * "unstoppable data combination" visible to the client.
 *
 * (Routed at /admin/cross-scan-insights, not /admin/insights, because the latter
 * already hosts the unmet-intents / integration-templates / health console - this
 * is the distinct platform-scan cross-modality surface.)
 *
 * It reads GET /api/admin/platform-scans/insights and renders, on the console kit:
 *   1. Metric tiles - the insight count by kind (the four higher-order kinds).
 *   2. The insight FEED grouped by kind, each card showing a severity pill +
 *      modalities + the narrative + the member findings that compose the chain.
 *   3. Explicit empty + error states - never a blank page.
 *
 * A "Generate now" action POSTs to the same route to correlate the corpus on
 * demand (persist + analytics + audit happen server-side).
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). Unauthenticated users are redirected to /login, never shown a
 * blank state. Mirrors the chrome of /admin/benchmark + /admin/platform-scans.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  GlassPanel,
  MetricTile,
  StatusPill,
  SectionHeader,
  ConsoleGrid,
} from "@/components/console";

// Mirrors InsightRow in src/lib/platform-scan/insights/insights-store.ts.
type InsightKind =
  | "compound_risk"
  | "regression"
  | "systemic_pattern"
  | "coverage_blind_spot";

interface FindingRef {
  platform: string;
  route: string;
  severity: string;
  category: string;
  title: string;
}

interface InsightRow {
  id: string;
  generatedAt: string;
  platform: string;
  kind: InsightKind;
  severity: string;
  modalities: string[];
  members: FindingRef[];
  narrative: string;
  status: string;
  key: string;
}

const KIND_ORDER: InsightKind[] = [
  "compound_risk",
  "regression",
  "systemic_pattern",
  "coverage_blind_spot",
];

// Operator-facing framing per insight kind so the feed reads as intelligence, not
// a metric dump.
const KIND_LABEL: Record<InsightKind, string> = {
  compound_risk: "Compound risk",
  regression: "Regression",
  systemic_pattern: "Systemic pattern",
  coverage_blind_spot: "Coverage blind spot",
};
const KIND_SUBTITLE: Record<InsightKind, string> = {
  compound_risk: "Multiple modalities chain on one resource - worse than any single finding.",
  regression: "A previously-resolved finding reappeared - a fix regressed.",
  systemic_pattern: "The same weakness across many targets - fix it once at the source.",
  coverage_blind_spot: "A modality never scanned on a target - cannot claim a clean bill.",
};

// "2026-06-28T..." -> a short relative-ish label. Mirrors whenLabel on the
// benchmark + platform-scans pages so timestamps read the same way.
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

function InsightCard({ insight, index }: { insight: InsightRow; index: number }) {
  return (
    <GlassPanel
      testId={`insight-card-${insight.kind}-${index}`}
      padded
      style={{ marginBottom: "0.75rem" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.55rem" }}>
        <StatusPill status={insight.severity} testId={`insight-severity-${insight.kind}-${index}`} />
        <span
          data-testid={`insight-platform-${insight.kind}-${index}`}
          style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--wp-gold, #e8b528)" }}
        >
          {insight.platform}
        </span>
        <span style={{ flex: 1 }} />
        <time
          dateTime={insight.generatedAt}
          title={insight.generatedAt}
          style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #929cad)" }}
        >
          {whenLabel(insight.generatedAt)}
        </time>
      </div>

      {/* Modalities the insight spans - the cross-layer fingerprint. */}
      <div
        data-testid={`insight-modalities-${insight.kind}-${index}`}
        style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginBottom: "0.55rem" }}
      >
        {insight.modalities.map((m) => (
          <span
            key={m}
            style={{
              fontSize: "0.68rem",
              fontWeight: 600,
              padding: "0.1rem 0.45rem",
              borderRadius: "0.35rem",
              color: "var(--wp-text-dim, #b4bcc8)",
              border: "1px solid var(--wp-dark-border, #242a36)",
            }}
          >
            {m}
          </span>
        ))}
      </div>

      <p
        data-testid={`insight-narrative-${insight.kind}-${index}`}
        style={{ margin: 0, fontSize: "0.86rem", lineHeight: 1.5, color: "var(--wp-text, #e9edf4)" }}
      >
        {insight.narrative}
      </p>

      {insight.members.length > 0 && (
        <div
          data-testid={`insight-members-${insight.kind}-${index}`}
          style={{ marginTop: "0.6rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}
        >
          {insight.members.map((mem, i) => (
            <div
              key={`${mem.route}-${mem.title}-${i}`}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", fontSize: "0.78rem" }}
            >
              <StatusPill status={mem.severity} size="sm" hideDot />
              <code style={{ fontFamily: "monospace", color: "var(--wp-text-dim, #b4bcc8)" }}>{mem.route}</code>
              <span style={{ color: "var(--wp-text-muted, #929cad)" }}>
                {mem.category}/{mem.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </GlassPanel>
  );
}

function InsightGroup({ kind, insights }: { kind: InsightKind; insights: InsightRow[] }) {
  return (
    <div data-testid={`insight-group-${kind}`} style={{ marginBottom: "1.6rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: "0.7rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--wp-gold, #e8b528)",
          }}
        >
          {KIND_LABEL[kind]}
        </span>
        <span data-testid={`insight-count-${kind}`} style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--wp-text, #e9edf4)" }}>
          {insights.length}
        </span>
        <span style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #929cad)" }}>{KIND_SUBTITLE[kind]}</span>
      </div>
      {insights.length === 0 ? (
        <p data-testid={`insight-group-empty-${kind}`} style={{ fontSize: "0.83rem", color: "var(--wp-text-dim, #b4bcc8)", margin: 0 }}>
          None in the latest correlation.
        </p>
      ) : (
        insights.map((ins, i) => <InsightCard key={ins.id} insight={ins} index={i} />)
      )}
    </div>
  );
}

export default function CrossScanInsightsPage() {
  const router = useRouter();
  const [insights, setInsights] = useState<InsightRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/insights");
      if (!res.ok) throw new Error(`Failed to load cross-scan insights (HTTP ${res.status})`);
      const data = (await res.json()) as { ok?: boolean; insights?: InsightRow[] };
      setInsights(data.insights ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/insights", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Failed to generate insights (HTTP ${res.status})`);
      const data = (await res.json()) as { ok?: boolean; insights?: InsightRow[] };
      setInsights(data.insights ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, []);

  useEffect(() => {
    // Redirect unauthenticated users; never render a blank state.
    const u = getInstinctUser<{ role: string }>();
    if (!u) {
      router.push("/login?next=/admin/cross-scan-insights");
      return;
    }
    void load();
  }, [router, load]);

  const insightsByKind: Record<InsightKind, InsightRow[]> = {
    compound_risk: insights.filter((i) => i.kind === "compound_risk"),
    regression: insights.filter((i) => i.kind === "regression"),
    systemic_pattern: insights.filter((i) => i.kind === "systemic_pattern"),
    coverage_blind_spot: insights.filter((i) => i.kind === "coverage_blind_spot"),
  };

  const busy = loading || generating;

  return (
    <div data-testid="cross-scan-insights-page" style={{ padding: "1.5rem", maxWidth: 980, margin: "0 auto", color: "var(--wp-text, #e9edf4)" }}>
      <SectionHeader
        as="h1"
        eyebrow="Cross-scan intelligence"
        title="Cross-scan insights"
        subtitle="Higher-order insights correlated across modalities and across time - compound risks, regressions, systemic patterns, and coverage blind spots no single-layer scanner can see."
        actions={
          <>
            <button
              type="button"
              data-testid="generate-insights"
              disabled={busy}
              onClick={() => void generate()}
              style={{
                padding: "0.4rem 0.9rem",
                borderRadius: "0.4rem",
                border: "1px solid var(--wp-gold, #e8b528)",
                background: "var(--wp-gold, #e8b528)",
                color: "#0b0b0c",
                fontWeight: 700,
                fontSize: "0.83rem",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {generating ? "Correlating..." : "Generate now"}
            </button>
            <button
              type="button"
              data-testid="refresh-insights"
              disabled={busy}
              onClick={() => void load()}
              style={{
                padding: "0.4rem 0.9rem",
                borderRadius: "0.4rem",
                border: "1px solid var(--wp-gold, #e8b528)",
                background: "transparent",
                color: "var(--wp-gold, #e8b528)",
                fontWeight: 600,
                fontSize: "0.83rem",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
            <Link href="/admin/platform-scans" data-testid="back-to-scans" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
              Platform scans
            </Link>
          </>
        }
      />

      {loading ? (
        <p data-testid="insights-loading" style={{ color: "var(--wp-text-dim, #b4bcc8)" }}>Loading...</p>
      ) : error ? (
        <p data-testid="insights-error" style={{ color: "var(--wp-error, #ef4444)" }}>{error}</p>
      ) : insights.length === 0 ? (
        <p data-testid="insights-empty" style={{ color: "var(--wp-text-dim, #b4bcc8)" }}>
          No cross-scan insights yet - run scans across multiple modalities, then Generate now to correlate the corpus into higher-order insights.
        </p>
      ) : (
        <>
          {/* 1. Metric tiles: insight count by kind. */}
          <ConsoleGrid testId="insights-metrics" minColWidth={200} style={{ marginBottom: "1.6rem" }}>
            <GlassPanel padded testId="metric-panel-total">
              <MetricTile testId="metric-total" value={insights.length} label="Total insights" kicker="Cross-scan" accent="var(--wp-gold, #e8b528)" />
            </GlassPanel>
            {KIND_ORDER.map((kind) => (
              <GlassPanel key={kind} padded testId={`metric-panel-${kind}`}>
                <MetricTile
                  testId={`metric-${kind}`}
                  value={insightsByKind[kind].length}
                  label={KIND_LABEL[kind]}
                  kicker="Insights"
                />
              </GlassPanel>
            ))}
          </ConsoleGrid>

          {/* 2. The insight feed grouped by kind. */}
          <div data-testid="insights-feed">
            {KIND_ORDER.map((kind) => (
              <InsightGroup key={kind} kind={kind} insights={insightsByKind[kind]} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
