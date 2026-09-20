"use client";

/**
 * Forcefield (OGIAM.com agent defense): where and when ogiam.com is being used, on our own
 * infrastructure (no third-party analytics product). Reads the aggregated
 * summary from /api/admin/site-analytics and renders the REUSED HourHeatmap
 * (time of day) plus top pages and top countries. Gated by analytics.view.
 *
 * All fetches go through fetchWithRefresh (15-min access TTL) per repo policy.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { HourHeatmap } from "@/components/HourHeatmap";
import { AgentOriginMap } from "@/components/AgentOriginMap";
import { AgentJourneyTimeline } from "@/components/AgentJourneyTimeline";
import { AgentActionLog } from "@/components/AgentActionLog";
import type { JourneyStep } from "@/lib/agent-behavior";
import { triageJourneys, type Severity } from "@/lib/agent-triage";
import { consolidateByOperator, deriveOperatorInsight, deriveTrustProfile, aggregateTradecraft } from "@/lib/agent-operators-view";
import { decideEdgeAction, type EdgeMode } from "@/lib/forcefield/edge-enforcement";
import { ForcefieldSwitch } from "@/components/ForcefieldSwitch";
import { ForcefieldAssurance } from "@/components/forcefield/ForcefieldAssurance";
import { ProbeIntelPanel } from "@/components/forcefield/ProbeIntelPanel";
import { PayloadIntelPanel } from "@/components/forcefield/PayloadIntelPanel";

interface Summary {
  rangeDays: number;
  totalPageViews: number;
  totalEvents: number;
  byHour: Array<{ hour: number; count: number }>;
  byPage: Array<{ path: string; count: number }>;
  byCountry: Array<{ country: string; count: number }>;
  byType: Array<{ type: string; count: number }>;
  forcefield: {
    welcomed: number;
    flagged: number;
    trapped: number;
    topAgents: Array<{ agent: string; count: number }>;
  };
  journeys: Array<{
    key: string;
    confidence: "proven" | "inferred";
    behaviorClass: string;
    signals: string[];
    path: string[];
    steps: JourneyStep[];
    eventCount: number;
    firstAt: string;
    lastAt: string;
    summary: string;
    profile: AgentProfile;
    triage: TriageStatus;
  }>;
  agentOrigins: Array<{ country: string; total: number; welcomed: number; welcomedVerified: number; flagged: number; hostile: number }>;
  probeIntel: Array<{ label: string; cwe: string; severity: "low" | "medium" | "high" | "critical"; category: string; count: number }>;
  payloadIntel: Array<{ attack: string; count: number }>;
  operatorTriage: Record<string, TriageStatus>;
  blockedOperators: string[];
  networkReputation?: Record<string, { operatorKey: string; otherWorkspaces: number; severity: "hostile" | "elevated" | "benign"; ttps?: string[] }>;
  principalByOperator?: Record<string, { status: "verified" | "claimed"; principal?: string; issuer?: string; scopes: string[]; mandateExceeded: boolean; violations: string[] }>;
}

interface AgentProfile {
  operatorKey: string;
  correlationKey: string;
  verdict: { confidence: "proven" | "inferred"; why: string };
  processes: Array<{ signal: string; label: string; meaning: string; hostile: boolean }>;
  scaffolding: {
    readsRobotsFirst: boolean;
    probedSensitive: boolean;
    pathDiscovery: string;
    requestCount: number;
    spanSeconds: number;
    observability: string;
  };
  toolComposition: {
    usedTools: string[];
    novelTools: string[];
    policies: string[];
    riskTier: string;
    intent: string;
    confidence: string;
    summary: string;
  };
  policies: string[];
  timeline: { firstAt: string; lastAt: string; spanSeconds: number; eventCount: number };
  disclaimer: string;
  insights: Array<{ kind: "impersonation"; claimedAgent: string; detail: string } | { kind: "deliberate_violation"; detail: string } | { kind: "payload_attack"; attack: string; detail: string }>;
}

const CLASS_LABEL: Record<string, string> = {
  benign_crawler: "Benign crawler",
  aggressive_scraper: "Aggressive scraper",
  exploit_attempt: "Exploit attempt",
  vuln_scanner: "Vulnerability scanner",
  form_spammer: "Form spammer",
  suspicious: "Suspicious automation",
  unclassified: "Unclassified",
};
const CLASS_COLOR: Record<string, string> = {
  benign_crawler: "var(--wp-success, #30a46c)",
  aggressive_scraper: "var(--wp-error, #ef4444)",
  exploit_attempt: "var(--wp-error, #ef4444)",
  vuln_scanner: "var(--wp-error, #ef4444)",
  form_spammer: "var(--wp-warning, #f5a623)",
  suspicious: "var(--wp-warning, #f5a623)",
  unclassified: "var(--wp-text-muted, #9ca3af)",
};

type TriageStatus = "new" | "acknowledged" | "escalated" | "dismissed";

const RANGES = [7, 30, 90] as const;

export default function SiteAnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sevFilter, setSevFilter] = useState<Severity | "all">("all");
  const [provenOnly, setProvenOnly] = useState(false);
  const [showBenign, setShowBenign] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [triageOverride, setTriageOverride] = useState<Record<string, TriageStatus>>({});
  const [journeyView, setJourneyView] = useState<"severity" | "operator">("operator");
  const [operatorTriageOverride, setOperatorTriageOverride] = useState<Record<string, TriageStatus>>({});
  const [blockedOverride, setBlockedOverride] = useState<Record<string, boolean>>({});
  const [promotedOps, setPromotedOps] = useState<Record<string, boolean>>({});
  // The page is org-wide readable; write controls render only for callers who
  // hold the capability, so a viewer never sees a button that would 403. Least
  // privilege until the server tells us otherwise.
  const [permissions, setPermissions] = useState<{ triage: boolean; manageOperators: boolean }>({ triage: false, manageOperators: false });
  const [repOptIn, setRepOptIn] = useState<{ contribute: boolean; consume: boolean } | null>(null);
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("monitor");
  const [edgeAutoBlock, setEdgeAutoBlock] = useState(false);
  const [highlightOp, setHighlightOp] = useState<string | null>(null);

  const toggleProfile = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setTriage = useCallback(async (key: string, status: TriageStatus) => {
    setTriageOverride((prev) => ({ ...prev, [key]: status })); // optimistic
    try {
      await fetchWithRefresh("/api/admin/site-analytics/triage", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ findingKey: key, status }),
      });
    } catch {
      /* optimistic value stays; a reload reconciles with the server */
    }
  }, []);

  const setOperatorTriage = useCallback(async (opKey: string, status: TriageStatus) => {
    setOperatorTriageOverride((prev) => ({ ...prev, [opKey]: status }));
    try {
      await fetchWithRefresh("/api/admin/site-analytics/triage", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ findingKey: `op:${opKey}`, status }),
      });
    } catch {
      /* optimistic; a reload reconciles */
    }
  }, []);

  const setOperatorBlocked = useCallback(async (opKey: string, block: boolean) => {
    setBlockedOverride((prev) => ({ ...prev, [opKey]: block }));
    try {
      const res = await fetchWithRefresh("/api/admin/operators/block", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ operatorKey: opKey, block }),
      });
      if (!res.ok) setBlockedOverride((prev) => ({ ...prev, [opKey]: !block })); // revert (e.g. 403: needs admin)
    } catch {
      setBlockedOverride((prev) => ({ ...prev, [opKey]: !block }));
    }
  }, []);

  const promoteOperator = useCallback(async (opKey: string) => {
    setPromotedOps((prev) => ({ ...prev, [opKey]: true })); // optimistic
    try {
      const res = await fetchWithRefresh("/api/admin/site-analytics/operator/promote", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ operatorKey: opKey }),
      });
      if (!res.ok) setPromotedOps((prev) => ({ ...prev, [opKey]: false }));
    } catch {
      setPromotedOps((prev) => ({ ...prev, [opKey]: false }));
    }
  }, []);

  // Jump from a named agent chip (in the Forcefield hero) to that operator's full
  // card: switch to the operator view, scroll it into view, and flash a ring so
  // the eye lands on the right actor.
  const focusOperator = useCallback((operatorKey: string) => {
    setJourneyView("operator");
    setHighlightOp(operatorKey);
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        const el = document.querySelector(`[data-testid="operator-${operatorKey}"]`);
        if (el && typeof (el as HTMLElement).scrollIntoView === "function") (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
      window.setTimeout(() => setHighlightOp((k) => (k === operatorKey ? null : k)), 2600);
    }
  }, []);

  const savePolicy = useCallback(async (next: { mode: EdgeMode; autoBlock: boolean }, prev: { mode: EdgeMode; autoBlock: boolean }) => {
    setEdgeMode(next.mode); setEdgeAutoBlock(next.autoBlock); // optimistic
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/edge-policy", { method: "POST", headers: jsonHeaders(), body: JSON.stringify(next) });
      if (!res.ok) { setEdgeMode(prev.mode); setEdgeAutoBlock(prev.autoBlock); }
    } catch { setEdgeMode(prev.mode); setEdgeAutoBlock(prev.autoBlock); }
  }, []);

  const saveReputationOptIn = useCallback(async (next: { contribute: boolean; consume: boolean }) => {
    let prev: { contribute: boolean; consume: boolean } | null = null;
    setRepOptIn((p) => { prev = p; return next; }); // optimistic
    try {
      const res = await fetchWithRefresh("/api/admin/forcefield/reputation-optin", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(next),
      });
      if (!res.ok) setRepOptIn(prev); // revert on rejection
    } catch {
      setRepOptIn(prev);
    }
  }, []);

  const load = useCallback(async (range: number) => {
    setState("loading");
    setTriageOverride({});
    setOperatorTriageOverride({});
    setBlockedOverride({});
    setPromotedOps({});
    try {
      const res = await fetchWithRefresh(`/api/admin/site-analytics?days=${range}`);
      if (!res.ok) {
        setState("error");
        return;
      }
      const body = (await res.json()) as { summary: Summary; permissions?: { triage: boolean; manageOperators: boolean } };
      setSummary(body.summary);
      if (body.permissions) setPermissions(body.permissions);
      // The reputation-network opt-in lives behind a manage capability; a 403 just
      // means this viewer can't toggle it, which is fine - leave it null.
      void fetchWithRefresh("/api/admin/forcefield/reputation-optin")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d?.optIn) setRepOptIn(d.optIn); })
        .catch(() => {});
      void fetchWithRefresh("/api/admin/forcefield/edge-policy")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d?.mode === "enforce" || d?.mode === "monitor") { setEdgeMode(d.mode); setEdgeAutoBlock(d.autoBlock === true); } })
        .catch(() => {});
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const card: React.CSSProperties = {
    background: "var(--wp-dark-surface, #1f1f22)",
    border: "1px solid var(--wp-dark-border, #333)",
    borderRadius: 8,
    padding: "1.1rem 1.2rem",
  };
  const label: React.CSSProperties = {
    fontSize: "0.72rem",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "var(--wp-text-muted, #9ca3af)",
  };

  type Journey = Summary["journeys"][number];
  const currentStatus = (j: Journey): TriageStatus => triageOverride[j.key] ?? j.triage;
  const TRIAGE_META: Record<Exclude<TriageStatus, "new">, { label: string; color: string }> = {
    acknowledged: { label: "acknowledged", color: "var(--wp-text-muted, #9ca3af)" },
    escalated: { label: "escalated", color: "var(--wp-error, #ef4444)" },
    dismissed: { label: "dismissed", color: "var(--wp-text-muted, #6b7280)" },
  };
  const triageBtn = (j: Journey, status: TriageStatus, text: string, color: string) => (
    <button
      type="button"
      data-testid={`triage-${status}-${j.key}`}
      onClick={() => setTriage(j.key, currentStatus(j) === status ? "new" : status)}
      aria-pressed={currentStatus(j) === status}
      style={{
        padding: "0.12rem 0.5rem", borderRadius: 999, fontSize: "0.68rem", fontWeight: 600, cursor: "pointer",
        background: currentStatus(j) === status ? color : "transparent",
        color: currentStatus(j) === status ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #9ca3af)",
        border: `1px solid ${color}`,
      }}
    >
      {text}
    </button>
  );
  const renderJourneyCard = (j: Journey) => (
    <li key={j.key} data-testid={`ff-journey-${j.key}`} style={{ border: "1px solid var(--wp-dark-border, #333)", borderRadius: 6, padding: "0.7rem 0.8rem", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: "0.9rem", color: CLASS_COLOR[j.behaviorClass] ?? "var(--wp-text, #eee)" }}>
          {CLASS_LABEL[j.behaviorClass] ?? j.behaviorClass}
        </span>
        <span
          style={{
            fontSize: "0.66rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em",
            padding: "0.1rem 0.4rem", borderRadius: 999,
            background: j.confidence === "proven" ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-surface2, #1a1a1a)",
            color: j.confidence === "proven" ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #9ca3af)",
            border: j.confidence === "proven" ? "none" : "1px solid var(--wp-dark-border, #333)",
          }}
        >
          {j.confidence}
        </span>
        {j.profile.insights.map((ins) => (
          <span
            key={ins.kind}
            data-testid={`insight-badge-${ins.kind}-${j.key}`}
            title={ins.detail}
            style={{
              fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em",
              padding: "0.1rem 0.4rem", borderRadius: 999,
              background: ins.kind === "deliberate_violation" ? "var(--wp-warning, #f5a623)" : "var(--wp-error, #ef4444)",
              color: "var(--wp-dark, #0b0d11)",
            }}
          >
            {ins.kind === "impersonation" ? "impersonation" : ins.kind === "payload_attack" ? "exploit" : "deliberate"}
          </span>
        ))}
        {currentStatus(j) !== "new" && (
          <span
            data-testid={`triage-badge-${j.key}`}
            style={{
              fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em",
              padding: "0.1rem 0.4rem", borderRadius: 999, color: TRIAGE_META[currentStatus(j) as Exclude<TriageStatus, "new">].color,
              border: `1px solid ${TRIAGE_META[currentStatus(j) as Exclude<TriageStatus, "new">].color}`,
            }}
          >
            {TRIAGE_META[currentStatus(j) as Exclude<TriageStatus, "new">].label}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)" }}>{j.eventCount} events</span>
      </div>
      {/* Collapsed: one compact line (the key path) so the triage queue scans
          fast without heavy scroll. Summary, full path timeline, and the profile
          all live behind Details. */}
      {!expanded.has(j.key) && j.path.length > 0 && (
        <div data-testid={`ff-journey-preview-${j.key}`} style={{ marginTop: "0.35rem", display: "flex", alignItems: "center", gap: "0.4rem", minWidth: 0 }}>
          <span style={{ fontFamily: "var(--wp-mono, ui-monospace, monospace)", fontSize: "0.7rem", color: "var(--wp-text-muted, #9ca3af)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {j.path[0]}{j.path.length > 1 ? `  +${j.path.length - 1} more` : ""}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={() => toggleProfile(j.key)}
        aria-expanded={expanded.has(j.key)}
        data-testid={`ff-journey-profile-toggle-${j.key}`}
        style={{ marginTop: "0.4rem", background: "transparent", border: "none", color: "var(--wp-gold, #e8b528)", fontSize: "0.74rem", fontWeight: 600, cursor: "pointer", padding: 0 }}
      >
        {expanded.has(j.key) ? "▾ Hide details" : "▸ View details"}
      </button>
      {expanded.has(j.key) && (
        <>
          <p style={{ margin: "0.45rem 0 0", fontSize: "0.8rem", color: "var(--wp-text, #eee)", lineHeight: 1.5 }}>{j.summary}</p>
          {j.steps && j.steps.length > 0 ? (
            <AgentJourneyTimeline steps={j.steps} testId={`journey-timeline-${j.key}`} />
          ) : (
            j.path.length > 0 && (
              <div style={{ marginTop: "0.45rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)", overflowX: "auto", whiteSpace: "nowrap" }}>
                {j.path.join("  →  ")}
              </div>
            )
          )}
          <AgentProfilePanel profile={j.profile} testKey={j.key} />
        </>
      )}
      {permissions.triage && (
        <div style={{ marginTop: "0.55rem", display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #6b7280)", marginRight: "0.15rem" }}>Triage</span>
          {triageBtn(j, "acknowledged", "Acknowledge", "var(--wp-text-muted, #9ca3af)")}
          {triageBtn(j, "escalated", "Escalate", "var(--wp-error, #ef4444)")}
          {triageBtn(j, "dismissed", "Dismiss", "var(--wp-text-muted, #6b7280)")}
        </div>
      )}
    </li>
  );

  return (
    <div data-testid="site-analytics-page" style={{ display: "grid", gap: "1.25rem", maxWidth: 920 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700, color: "var(--wp-text, #eee)", display: "flex", alignItems: "center", gap: "0.55rem", flexWrap: "wrap" }}>
            Forcefield
            <span
              data-testid="site-analytics-scope"
              style={{
                fontSize: "0.7rem",
                fontWeight: 700,
                letterSpacing: "0.02em",
                padding: "0.15rem 0.5rem",
                borderRadius: 999,
                background: "var(--wp-gold, #e8b528)",
                color: "var(--wp-dark, #0b0d11)",
              }}
            >
              ogiam.com
            </span>
          </h1>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", color: "var(--wp-text-muted, #9ca3af)" }}>
            This tab covers ogiam.com only: where and when it is used, and how Forcefield
            handled agent traffic. Our own data, no third-party analytics.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              data-testid={`range-${r}`}
              onClick={() => setDays(r)}
              style={{
                padding: "0.35rem 0.7rem",
                borderRadius: 6,
                fontSize: "0.78rem",
                fontWeight: 600,
                cursor: "pointer",
                background: days === r ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-surface2, #1a1a1a)",
                color: days === r ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #9ca3af)",
                border: "1px solid var(--wp-gold, #e8b528)",
              }}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {state === "loading" && (
        <div data-testid="site-analytics-loading" style={{ ...card, color: "var(--wp-text-muted, #9ca3af)" }}>
          Loading…
        </div>
      )}
      {state === "error" && (
        <div data-testid="site-analytics-error" style={{ ...card, color: "var(--wp-error, #ef4444)" }}>
          Could not load site analytics right now.
        </div>
      )}

      {state === "ready" && summary && (
        <>
          {/* Forcefield hero: the prominent auto-block on/off. The count is how many
              operators in view the edge would block or challenge if protection were on. */}
          {permissions.manageOperators && (() => {
            // The specific operators the edge would act on, named (not just
            // counted) so protection reads as concrete. Worst-first, block above
            // challenge, computed with the same pure policy the edge enforces.
            const standbyAgents = consolidateByOperator(summary.journeys)
              .map((g) => {
                const pr = summary.principalByOperator?.[g.operatorKey];
                const d = decideEdgeAction(
                  {
                    blocked: blockedOverride[g.operatorKey] ?? (summary.blockedOperators ?? []).includes(g.operatorKey),
                    trustBand: deriveTrustProfile(g).band,
                    mandateExceeded: pr?.mandateExceeded ?? false,
                    principalStatus: pr?.status ?? "absent",
                    networkHostile: summary.networkReputation?.[g.operatorKey]?.severity === "hostile",
                  },
                  { mode: "enforce" },
                );
                return { operatorKey: g.operatorKey, action: d.intended };
              })
              .filter((a): a is { operatorKey: string; action: "block" | "challenge" } => a.action !== "allow")
              .sort((a, b) => (a.action === b.action ? 0 : a.action === "block" ? -1 : 1));
            return (
              <ForcefieldSwitch
                mode={edgeMode}
                canManage={permissions.manageOperators}
                onToggle={(next) => void savePolicy({ mode: next, autoBlock: edgeAutoBlock }, { mode: edgeMode, autoBlock: edgeAutoBlock })}
                autoBlock={edgeAutoBlock}
                onAutoBlockToggle={(b) => void savePolicy({ mode: edgeMode, autoBlock: b }, { mode: edgeMode, autoBlock: edgeAutoBlock })}
                standbyAgents={standbyAgents}
                onAgentClick={focusOperator}
              />
            );
          })()}

          {permissions.manageOperators && <ForcefieldAssurance />}

          {/* Totals */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1rem" }}>
            <div style={card}>
              <div style={label}>Page views ({summary.rangeDays}d)</div>
              <div data-testid="total-page-views" style={{ marginTop: "0.3rem", fontSize: "1.6rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                {summary.totalPageViews.toLocaleString()}
              </div>
            </div>
            <div style={card}>
              <div style={label}>Total events</div>
              <div style={{ marginTop: "0.3rem", fontSize: "1.6rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                {summary.totalEvents.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Heatmap (reused) */}
          <div style={card}>
            <div style={label}>Page views by hour of day (UTC)</div>
            <div style={{ marginTop: "0.8rem" }}>
              <HourHeatmap data={summary.byHour} testIdPrefix="site-hour" unitLabel="view" />
            </div>
            {summary.totalPageViews === 0 && (
              <p data-testid="site-analytics-empty" style={{ marginTop: "0.7rem", fontSize: "0.78rem", color: "var(--wp-text-muted, #9ca3af)" }}>
                No page views recorded in this window yet.
              </p>
            )}
          </div>

          {/* Top pages + countries. Collapsed by default (native <details>) so
              they reclaim the real estate; the summary shows the count and the
              content stays in the DOM. auto-fit collapses to one column on
              narrow screens. */}
          <style>{`
            details.ff-collapse > summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
            details.ff-collapse > summary::-webkit-details-marker { display: none; }
            details.ff-collapse .ff-chev { transition: transform 0.15s ease; color: var(--wp-text-muted, #9ca3af); font-size: 0.8rem; }
            details.ff-collapse[open] .ff-chev { transform: rotate(90deg); }
          `}</style>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem" }}>
            <details className="ff-collapse" style={card} data-testid="top-pages-collapse">
              <summary>
                <span style={label}>Top pages</span>
                <span style={{ ...label, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  {summary.byPage.length} <span className="ff-chev">&#9656;</span>
                </span>
              </summary>
              <ul data-testid="top-pages" style={{ listStyle: "none", margin: "0.7rem 0 0", padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "0.35rem" }}>
                {summary.byPage.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No data</li>
                )}
                {summary.byPage.map((p) => (
                  <li key={p.path} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.path}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{p.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </details>
            <details className="ff-collapse" style={card} data-testid="top-countries-collapse">
              <summary>
                <span style={label}>Top countries</span>
                <span style={{ ...label, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  {summary.byCountry.length} <span className="ff-chev">&#9656;</span>
                </span>
              </summary>
              <ul data-testid="top-countries" style={{ listStyle: "none", margin: "0.7rem 0 0", padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "0.35rem" }}>
                {summary.byCountry.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No data</li>
                )}
                {summary.byCountry.map((c) => (
                  <li key={c.country} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.country}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{c.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          {/* Agent origin map: where agent traffic reached us from. */}
          <div style={card} data-testid="ff-origin-map">
            <div style={label}>Agent origins &middot; where agent traffic reaches us from</div>
            <div style={{ marginTop: "0.9rem" }}>
              <AgentOriginMap origins={summary.agentOrigins ?? []} />
            </div>
          </div>

          {/* Probe intelligence + payload attacks, in the shared Forcefield visual language. */}
          <ProbeIntelPanel intel={summary.probeIntel ?? []} />
          <PayloadIntelPanel intel={summary.payloadIntel ?? []} />

          {/* Forcefield for the Web: agent traffic on ogiam.com. Watch-first, so
              these are observed, not blocked. */}
          <div style={card} data-testid="ff-agent-traffic">
            <div style={label}>Forcefield &middot; agent traffic (watch-first, nothing blocked)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem", marginTop: "0.8rem" }}>
              <div>
                <div style={{ ...label, color: "var(--wp-success, #30a46c)" }}>Agents welcomed</div>
                <div data-testid="ff-welcomed" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {summary.forcefield.welcomed.toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-warning, #f5a623)" }}>Automation flagged</div>
                <div data-testid="ff-flagged" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {summary.forcefield.flagged.toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-error, #ef4444)" }}>Decoy trips</div>
                <div data-testid="ff-trapped" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {summary.forcefield.trapped.toLocaleString()}
                </div>
              </div>
            </div>
            <div style={{ marginTop: "1rem" }}>
              <div style={label}>Top identified agents (welcome lane)</div>
              <ul data-testid="ff-top-agents" style={{ listStyle: "none", margin: "0.5rem 0 0", padding: 0, display: "grid", gap: "0.35rem" }}>
                {summary.forcefield.topAgents.length === 0 && (
                  <li style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No agent traffic recorded yet.</li>
                )}
                {summary.forcefield.topAgents.map((a) => (
                  <li key={a.agent} style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.agent}</span>
                    <span style={{ flexShrink: 0, color: "var(--wp-text-muted, #9ca3af)" }}>{a.count.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p style={{ marginTop: "0.9rem", fontSize: "0.76rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.5 }}>
              Welcomed = identified good agents (search + AI crawlers). Flagged = unidentified
              automation, a weak signal recorded only. Decoy trips = a scraper followed an
              invisible, robots-disallowed honeypot link, near-certainly ignoring the rules.
            </p>
          </div>

          {/* Agent journeys: correlated sessions, each a behavior class with a
              proven/inferred confidence. Following the agent's flow across the
              surface, not just single events. */}
          <div style={card} data-testid="ff-journeys">
            <div style={label}>Agent journeys &middot; behavior across the surface</div>
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.76rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.5 }}>
              Every agent that touched the site, consolidated into one actor with its whole journey: a
              <strong style={{ color: "var(--wp-text, #eee)" }}> trust score</strong>, its
              <strong style={{ color: "var(--wp-text, #eee)" }}> intent</strong>, the path it took, and what the edge would do about it.
              A card is <strong style={{ color: "var(--wp-text, #eee)" }}>distinctive</strong> when the actor is pinned by a token it
              carried (a trap or a hidden field only a bot touches), or <strong style={{ color: "var(--wp-text, #eee)" }}>inferred</strong>
              {" "}when it is grouped by a coarser fingerprint (a likely match, not confirmed). Switch to
              <strong style={{ color: "var(--wp-text, #eee)" }}> By severity</strong> to work the raw findings as a triage queue.
            </p>
            {/* View toggle: triage findings by severity, or consolidate them by operator. */}
            <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.8rem" }}>
              {(["severity", "operator"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  data-testid={`journey-view-${v}`}
                  onClick={() => setJourneyView(v)}
                  style={{
                    padding: "0.2rem 0.7rem", borderRadius: 999, fontSize: "0.72rem", fontWeight: 600, cursor: "pointer",
                    background: journeyView === v ? "var(--wp-gold, #e8b528)" : "transparent",
                    color: journeyView === v ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #9ca3af)",
                    border: "1px solid var(--wp-dark-border, #333)",
                  }}
                >
                  {v === "severity" ? "By severity" : "By operator"}
                </button>
              ))}
            </div>

            {journeyView === "operator" && (
              <div data-testid="ff-operators-view" style={{ marginTop: "0.9rem", display: "grid", gap: "0.7rem" }}>
                {permissions.manageOperators && (
                  <div data-testid="reputation-optin" style={{ display: "grid", gap: "0.35rem", padding: "0.55rem 0.7rem", borderRadius: 8, background: "var(--wp-dark-2, rgba(255,255,255,0.03))", border: "1px solid var(--wp-dark-border, #333)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>Reputation network</span>
                      <span style={{ fontSize: "0.62rem", color: "var(--wp-text-muted, #9ca3af)" }}>opt-in · shares only an opaque fingerprint, never who reported it</span>
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #b8bcc4)", cursor: "pointer" }}>
                      <input type="checkbox" data-testid="reputation-optin-contribute" checked={!!repOptIn?.contribute} onChange={(e) => void saveReputationOptIn({ contribute: e.target.checked, consume: !!repOptIn?.consume })} />
                      Contribute this workspace&rsquo;s confirmed-hostile blocks
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #b8bcc4)", cursor: "pointer" }}>
                      <input type="checkbox" data-testid="reputation-optin-consume" checked={!!repOptIn?.consume} onChange={(e) => void saveReputationOptIn({ contribute: !!repOptIn?.contribute, consume: e.target.checked })} />
                      Flag operators already known hostile to other workspaces
                    </label>
                  </div>
                )}
                {(() => {
                  const groups = consolidateByOperator(summary.journeys);
                  if (groups.length === 0) return <p style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>No operators yet.</p>;
                  const opStatus = (k: string): TriageStatus => operatorTriageOverride[k] ?? summary.operatorTriage?.[k] ?? "new";
                  const isBlocked = (k: string): boolean => blockedOverride[k] ?? (summary.blockedOperators ?? []).includes(k);
                  const sevColor = (sv: string) => (sv === "hostile" ? "var(--wp-error, #ef4444)" : sv === "elevated" ? "var(--wp-warning, #f5a623)" : "var(--wp-success, #30a46c)");
                  const probeSevColor = (sv: string) => (sv === "critical" || sv === "high" ? "var(--wp-error, #ef4444)" : sv === "medium" ? "var(--wp-gold, #e8b528)" : "var(--wp-text-muted, #9ca3af)");
                  const opBtn = (opKey: string, status: TriageStatus, text: string, color: string) => (
                    <button
                      type="button"
                      data-testid={`operator-triage-${status}-${opKey}`}
                      onClick={() => setOperatorTriage(opKey, opStatus(opKey) === status ? "new" : status)}
                      style={{
                        padding: "0.12rem 0.5rem", borderRadius: 999, fontSize: "0.68rem", fontWeight: 600, cursor: "pointer",
                        background: opStatus(opKey) === status ? color : "transparent",
                        color: opStatus(opKey) === status ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #9ca3af)",
                        border: `1px solid ${color}`,
                      }}
                    >
                      {text}
                    </button>
                  );
                  const tradecraft = aggregateTradecraft(groups).slice(0, 8);
                  return (
                  <>
                  {groups.length > 1 && tradecraft.length > 0 && (
                    <div data-testid="tradecraft-corpus" style={{ border: "1px solid var(--wp-dark-border, #262a33)", borderRadius: 8, padding: "0.7rem 0.9rem", display: "grid", gap: "0.45rem", background: "radial-gradient(120% 120% at 20% 0%, #0e1626 0%, #0b0d11 72%)" }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "0.62rem", fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--wp-gold, #e8b528)" }}>Tradecraft across all operators</span>
                        <span style={{ fontSize: "0.66rem", color: "var(--wp-text-muted, #8b90a0)" }}>the most common methods over the {groups.length} operators seen, by distinct operator</span>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                        {tradecraft.map((t) => (
                          <span key={t.tag} data-testid={`tradecraft-${t.tag}`} style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.66rem", fontFamily: "var(--wp-mono, ui-monospace, monospace)", color: "var(--wp-text, #d8dbe0)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: 999, padding: "0.12rem 0.5rem" }}>
                            {t.tag.replace(/^attack:/, "\u2191 ")}<span style={{ color: "var(--wp-gold, #e8b528)", fontWeight: 700 }}>{t.operators}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {groups.map((g) => (
                    <div key={g.operatorKey} data-testid={`operator-${g.operatorKey}`} data-focused={highlightOp === g.operatorKey ? "true" : undefined} style={{ border: `1px solid ${highlightOp === g.operatorKey ? "var(--wp-gold, #e8b528)" : sevColor(g.severity)}`, borderRadius: 8, padding: "0.8rem 0.9rem", display: "grid", gap: "0.5rem", scrollMarginTop: "1rem", boxShadow: highlightOp === g.operatorKey ? "0 0 0 2px var(--wp-gold, #e8b528), 0 0 18px rgba(232,181,40,0.35)" : "none", transition: "box-shadow 220ms ease, border-color 220ms ease" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "var(--wp-mono, ui-monospace, monospace)", fontSize: "0.85rem", fontWeight: 700, color: "var(--wp-gold, #e8b528)" }}>{g.operatorKey}</span>
                        <span style={{ fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-dark, #0b0d11)", background: sevColor(g.severity), borderRadius: 999, padding: "0.1rem 0.45rem" }}>{g.severity}</span>
                        <span
                          data-testid={`operator-grouping-${g.operatorKey}`}
                          title={g.groupingReason}
                          style={{ fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", borderRadius: 999, padding: "0.1rem 0.45rem", color: g.grouping === "coarse" ? "var(--wp-warning, #f5a623)" : "var(--wp-success, #30a46c)", border: `1px solid ${g.grouping === "coarse" ? "var(--wp-warning, #f5a623)" : "var(--wp-success, #30a46c)"}` }}
                        >
                          {g.grouping === "coarse" ? "coarse grouping" : "distinctive"}
                        </span>
                        {opStatus(g.operatorKey) !== "new" && (
                          <span data-testid={`operator-status-${g.operatorKey}`} style={{ fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #9ca3af)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: 999, padding: "0.1rem 0.4rem" }}>{opStatus(g.operatorKey)}</span>
                        )}
                        {isBlocked(g.operatorKey) && (
                          <span data-testid={`operator-blocked-${g.operatorKey}`} style={{ fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-dark, #0b0d11)", background: "var(--wp-error, #ef4444)", borderRadius: 999, padding: "0.1rem 0.45rem" }}>blocked</span>
                        )}
                        {summary.networkReputation?.[g.operatorKey] && (() => {
                          const net = summary.networkReputation![g.operatorKey];
                          const c = net.severity === "hostile" ? "var(--wp-error, #ef4444)" : net.severity === "elevated" ? "var(--wp-warning, #f5a623)" : "var(--wp-text-muted, #9ca3af)";
                          return (
                            <span
                              data-testid={`operator-network-${g.operatorKey}`}
                              title={`Flagged as ${net.severity} by ${net.otherWorkspaces} other workspace${net.otherWorkspaces === 1 ? "" : "s"} on the reputation network - known bad beyond you${net.ttps && net.ttps.length ? `. Shared tradecraft: ${net.ttps.join(", ")}` : ""}`}
                              style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: c, border: `1px solid ${c}`, borderRadius: 999, padding: "0.1rem 0.45rem" }}
                            >
                              network: {net.severity} · {net.otherWorkspaces}{net.ttps && net.ttps.length ? ` · ${net.ttps.length} TTP${net.ttps.length === 1 ? "" : "s"}` : ""}
                            </span>
                          );
                        })()}
                        {summary.principalByOperator?.[g.operatorKey] && (() => {
                          const pr = summary.principalByOperator![g.operatorKey];
                          const exceeded = pr.mandateExceeded;
                          const verifiedClean = pr.status === "verified" && !exceeded;
                          const c = exceeded ? "var(--wp-error, #ef4444)" : verifiedClean ? "var(--wp-success, #30a46c)" : "var(--wp-warning, #f5a623)";
                          const label = exceeded ? "mandate exceeded" : verifiedClean ? "principal verified" : "principal claimed";
                          const title = exceeded
                            ? `Verified principal ${pr.principal ?? ""} (issuer ${pr.issuer ?? "?"}) stepped OUTSIDE its granted scope [${pr.scopes.join(", ")}] - accessed ${pr.violations.length} unauthorized path(s): ${pr.violations.slice(0, 5).join(", ")}. An authorized agent abusing its mandate.`
                            : verifiedClean
                              ? `Delegation cryptographically verified: principal ${pr.principal ?? ""} via issuer ${pr.issuer ?? "?"}, acting within its granted scope [${pr.scopes.join(", ")}].`
                              : `A delegation credential was presented but did NOT verify against any registered issuer. Claimed principal ${pr.principal ?? "(unstated)"} - treated as unauthenticated.`;
                          return (
                            <span
                              data-testid={`operator-principal-${g.operatorKey}`}
                              title={title}
                              style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: c, border: `1px solid ${c}`, borderRadius: 999, padding: "0.1rem 0.45rem" }}
                            >
                              {label}
                            </span>
                          );
                        })()}
                        <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)" }}>{g.findingCount} finding{g.findingCount === 1 ? "" : "s"}</span>
                        {(() => {
                          const pr = summary.principalByOperator?.[g.operatorKey];
                          const decision = decideEdgeAction(
                            {
                              blocked: isBlocked(g.operatorKey),
                              trustBand: deriveTrustProfile(g).band,
                              mandateExceeded: pr?.mandateExceeded ?? false,
                              principalStatus: pr?.status ?? "absent",
                              networkHostile: summary.networkReputation?.[g.operatorKey]?.severity === "hostile",
                            },
                            { mode: edgeMode },
                          );
                          const c = decision.intended === "block" ? "var(--wp-error, #ef4444)" : decision.intended === "challenge" ? "var(--wp-warning, #f5a623)" : "var(--wp-success, #30a46c)";
                          const verb = edgeMode === "enforce"
                            ? (decision.intended === "allow" ? "allowing" : decision.intended === "block" ? "blocking" : "challenging")
                            : `would ${decision.intended}`;
                          return (
                            <span
                              data-testid={`operator-edge-${g.operatorKey}`}
                              title={`${edgeMode === "enforce" ? "Enforcing" : "Monitor (shadow)"}: ${decision.reason} [rule: ${decision.ruleId}]`}
                              style={{ fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: c, border: `1px solid ${c}`, borderRadius: 999, padding: "0.1rem 0.45rem" }}
                            >
                              edge: {verb}
                            </span>
                          );
                        })()}
                      </div>
                      {(() => {
                        const insight = deriveOperatorInsight(g);
                        const trust = deriveTrustProfile(g);
                        const actionColor: Record<string, string> = { block: "var(--wp-error, #ef4444)", escalate: "var(--wp-warning, #f5a623)", watch: "var(--wp-gold, #e8b528)", acknowledge: "var(--wp-text-muted, #9ca3af)" };
                        const bandColor: Record<string, string> = { trusted: "var(--wp-success, #30a46c)", caution: "var(--wp-gold, #e8b528)", untrusted: "var(--wp-warning, #f5a623)", hostile: "var(--wp-error, #ef4444)" };
                        return (
                          <div data-testid={`operator-insight-${g.operatorKey}`} style={{ display: "grid", gap: "0.4rem", padding: "0.5rem 0.6rem", borderRadius: 6, background: "var(--wp-dark-2, rgba(255,255,255,0.03))", border: "1px solid var(--wp-dark-border, #333)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                              <span data-testid={`operator-trust-${g.operatorKey}`} title={trust.rationale} style={{ display: "inline-flex", alignItems: "baseline", gap: "0.25rem", padding: "0.15rem 0.55rem", borderRadius: 8, border: `1px solid ${bandColor[trust.band]}`, background: `color-mix(in srgb, ${bandColor[trust.band]} 12%, transparent)` }}>
                                <span style={{ fontSize: "1.15rem", fontWeight: 800, lineHeight: 1, color: bandColor[trust.band] }}>{trust.score}</span>
                                <span style={{ fontSize: "0.58rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: bandColor[trust.band] }}>/100 {trust.band}</span>
                              </span>
                              <span style={{ fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #6b7280)" }}>Intent</span>
                              <span data-testid={`operator-intent-${g.operatorKey}`} style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--wp-text, #eee)" }}>{trust.intentLabel}</span>
                              <span style={{ fontSize: "0.6rem", color: "var(--wp-text-muted, #6b7280)" }}>({trust.intentConfidence})</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
                              <span data-testid={`operator-verdict-${g.operatorKey}`} style={{ fontSize: "0.82rem", fontWeight: 700, color: sevColor(g.severity) }}>{insight.verdict}</span>
                              <span data-testid={`operator-recommend-${g.operatorKey}`} title={insight.actionRationale} style={{ marginLeft: "auto", fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", borderRadius: 999, padding: "0.1rem 0.5rem", color: "var(--wp-dark, #0b0d11)", background: actionColor[insight.recommendedAction] }}>Recommend: {insight.recommendedAction}</span>
                            </div>
                            <span style={{ fontSize: "0.74rem", color: "var(--wp-text-muted, #9ca3af)" }}>{insight.targeting}</span>
                            {insight.tells.length > 0 && (
                              <ul style={{ margin: 0, paddingLeft: "1rem", display: "grid", gap: "0.12rem" }}>
                                {insight.tells.map((t, i) => (<li key={i} style={{ fontSize: "0.74rem", color: "var(--wp-text, #eee)" }}>{t}</li>))}
                              </ul>
                            )}
                            <span style={{ fontSize: "0.68rem", color: "var(--wp-text-muted, #6b7280)", fontStyle: "italic" }}>{insight.actionRationale}</span>
                          </div>
                        );
                      })()}
                      {(() => {
                        // The operator's PATH across the surface: every finding's
                        // ordered steps, merged and time-sorted, so the whole
                        // agent journey chains in one place (not buried per finding).
                        const opSteps = g.journeys
                          .flatMap((j) => j.steps ?? [])
                          .slice()
                          .sort((a, b) => a.at.localeCompare(b.at))
                          .slice(0, 40);
                        if (opSteps.length === 0) return null;
                        return (
                          <div data-testid={`operator-path-${g.operatorKey}`} style={{ display: "grid", gap: "0.55rem", minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
                              <span style={{ fontSize: "0.76rem", fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--wp-gold, #e8b528)" }}>Path across the surface</span>
                              <span style={{ fontSize: "0.68rem", color: "var(--wp-text-muted, #9ca3af)" }}>the full journey - every step this agent took, in order</span>
                            </div>
                            {/* quick-glance visual chain (the constellation) */}
                            <AgentJourneyTimeline steps={opSteps} testId={`operator-timeline-${g.operatorKey}`} />
                            {/* the readable case file: timestamps + plain language + before/during/after */}
                            <AgentActionLog steps={opSteps} testId={`operator-casefile-${g.operatorKey}`} />
                          </div>
                        );
                      })()}
                      <p style={{ margin: 0, fontSize: "0.79rem", color: "var(--wp-text, #eee)", lineHeight: 1.5 }}>
                        {g.behaviorClasses.map((c) => CLASS_LABEL[c] ?? c).join(", ")}
                        {(g.paths.length > 0 || g.attacks.length > 0) && (
                          <>
                            {" · targets: "}
                            <span style={{ color: "var(--wp-text-muted, #9ca3af)" }}>{[...g.attacks, ...g.paths].slice(0, 6).join(", ")}</span>
                          </>
                        )}
                      </p>
                      <p style={{ margin: 0, fontSize: "0.7rem", color: "var(--wp-text-muted, #9ca3af)", fontStyle: "italic", lineHeight: 1.4 }}>{g.groupingReason}</p>
                      <div data-testid={`operator-targeting-${g.operatorKey}`} style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", alignItems: "center" }}>
                        {g.targeting.categories.map((c) => (
                          <span key={c.category} title={`${c.count} path${c.count === 1 ? "" : "s"} in this category, worst severity ${c.severity}`} style={{ fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", borderRadius: 999, padding: "0.08rem 0.4rem", color: probeSevColor(c.severity), border: `1px solid ${probeSevColor(c.severity)}` }}>
                            {c.category} {c.count > 1 ? `×${c.count}` : ""}
                          </span>
                        ))}
                        {g.targeting.payloadTypes.map((p) => (
                          <span key={p} style={{ fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", borderRadius: 999, padding: "0.08rem 0.4rem", color: "var(--wp-error, #ef4444)", border: "1px solid var(--wp-error, #ef4444)" }}>
                            payload: {p}
                          </span>
                        ))}
                        <span style={{ fontSize: "0.66rem", color: "var(--wp-text-muted, #9ca3af)", fontStyle: "italic" }}>
                          {g.targeting.cadence.spanHours >= 24 ? `~${g.targeting.cadence.perDay}/day` : "within a day"}
                        </span>
                      </div>
                      {g.subActors.length > 1 && (
                        <div data-testid={`operator-subactors-${g.operatorKey}`} style={{ display: "grid", gap: "0.25rem", padding: "0.4rem 0.5rem", borderRadius: 6, background: "var(--wp-dark-2, rgba(255,255,255,0.03))", border: "1px solid var(--wp-dark-border, #333)" }}>
                          <span style={{ fontSize: "0.64rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #9ca3af)" }}>
                            {g.subActors.length} distinguishable profiles under this fingerprint
                          </span>
                          {g.subActors.map((sa) => (
                            <div key={sa.fingerprint} style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center", fontSize: "0.68rem" }}>
                              <span style={{ fontFamily: "var(--wp-mono, ui-monospace, monospace)", color: "var(--wp-text-muted, #9ca3af)" }}>{sa.fingerprint.split(".")[1]}</span>
                              <span style={{ color: "var(--wp-text, #eee)" }}>{[...sa.categories, ...sa.payloadTypes.map((p) => `payload:${p}`)].join(", ") || sa.pathDiscovery}</span>
                              <span style={{ marginLeft: "auto", color: "var(--wp-text-muted, #6b7280)" }}>{sa.findingCount} finding{sa.findingCount === 1 ? "" : "s"}</span>
                            </div>
                          ))}
                          <span style={{ fontSize: "0.6rem", color: "var(--wp-text-muted, #6b7280)", fontStyle: "italic" }}>
                            The coarse fingerprint stays the anchor for blocking + history; these are targeting profiles inside it, not separate identities.
                          </span>
                        </div>
                      )}
                      {(permissions.triage || permissions.manageOperators) && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center" }}>
                        <span style={{ fontSize: "0.66rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #6b7280)", marginRight: "0.15rem" }}>Operator</span>
                        {permissions.triage && (
                          <>
                            {opBtn(g.operatorKey, "acknowledged", "Acknowledge", "var(--wp-text-muted, #9ca3af)")}
                            {opBtn(g.operatorKey, "escalated", "Escalate", "var(--wp-error, #ef4444)")}
                            {opBtn(g.operatorKey, "dismissed", "Dismiss", "var(--wp-text-muted, #6b7280)")}
                          </>
                        )}
                        {permissions.manageOperators && (
                        <button
                          type="button"
                          data-testid={`operator-block-${g.operatorKey}`}
                          onClick={() => setOperatorBlocked(g.operatorKey, !isBlocked(g.operatorKey))}
                          style={{
                            marginLeft: "0.3rem", padding: "0.12rem 0.55rem", borderRadius: 999, fontSize: "0.68rem", fontWeight: 700, cursor: "pointer",
                            background: isBlocked(g.operatorKey) ? "var(--wp-error, #ef4444)" : "transparent",
                            color: isBlocked(g.operatorKey) ? "var(--wp-dark, #0b0d11)" : "var(--wp-error, #ef4444)",
                            border: "1px solid var(--wp-error, #ef4444)",
                          }}
                        >
                          {isBlocked(g.operatorKey) ? "Unblock" : "Block"}
                        </button>
                        )}
                        {permissions.triage && (
                        <button
                          type="button"
                          data-testid={`operator-promote-${g.operatorKey}`}
                          onClick={() => promoteOperator(g.operatorKey)}
                          disabled={promotedOps[g.operatorKey]}
                          title="Record this operator's findings to the persistent operators board so its dossier builds across visits."
                          style={{
                            padding: "0.12rem 0.55rem", borderRadius: 999, fontSize: "0.68rem", fontWeight: 600, cursor: promotedOps[g.operatorKey] ? "default" : "pointer",
                            background: "transparent",
                            color: promotedOps[g.operatorKey] ? "var(--wp-success, #30a46c)" : "var(--wp-gold, #e8b528)",
                            border: `1px solid ${promotedOps[g.operatorKey] ? "var(--wp-success, #30a46c)" : "var(--wp-gold, #e8b528)"}`,
                          }}
                        >
                          {promotedOps[g.operatorKey] ? "\u2713 On board" : "Promote to board"}
                        </button>
                        )}
                      </div>
                      )}
                      <details className="ff-op-findings" data-testid={`operator-findings-${g.operatorKey}`}>
                        <summary style={{ cursor: "pointer", fontSize: "0.72rem", color: "var(--wp-gold, #e8b528)", fontWeight: 600 }}>
                          <span className="ff-chev" aria-hidden>&#9656;</span>
                          Show {g.findingCount} finding{g.findingCount === 1 ? "" : "s"}
                        </summary>
                        <ul style={{ listStyle: "none", margin: "0.4rem 0 0", padding: 0, display: "grid", gap: "0.5rem" }}>
                          {g.journeys.map(renderJourneyCard)}
                        </ul>
                      </details>
                    </div>
                  ))}
                  </>
                  );
                })()}
              </div>
            )}

            <div data-testid="ff-journeys-triage" style={{ marginTop: "0.9rem", display: journeyView === "severity" ? "grid" : "none", gap: "0.8rem" }}>
              {journeyView === "severity" && (() => {
                const dismissedCount = summary.journeys.filter((x) => currentStatus(x) === "dismissed").length;
                const visibleJourneys = summary.journeys.filter((x) => showDismissed || currentStatus(x) !== "dismissed");
                const buckets = triageJourneys(visibleJourneys);
                const c = buckets.counts;
                if (summary.journeys.length === 0) {
                  return (
                    <p style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>
                      No correlated agent journeys yet. Sessions appear here as ogiam.com records agent signals.
                    </p>
                  );
                }
                const sevMeta: Record<Severity, { label: string; color: string }> = {
                  hostile: { label: "Threats", color: "var(--wp-error, #ef4444)" },
                  elevated: { label: "Elevated", color: "var(--wp-warning, #f5a623)" },
                  benign: { label: "Benign / neutral", color: "var(--wp-success, #30a46c)" },
                };
                const passProven = (x: Journey) => !provenOnly || x.confidence === "proven";
                const show = (sev: Severity) => sevFilter === "all" || sevFilter === sev;
                const hostile = buckets.hostile.filter(passProven);
                const elevated = buckets.elevated.filter(passProven);
                const benign = buckets.benign.filter(passProven);
                const chip = (color: string, n: number, text: string) => (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.78rem", color: "var(--wp-text, #eee)" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 999, background: color }} />
                    <strong>{n}</strong> <span style={{ color: "var(--wp-text-muted, #9ca3af)" }}>{text}</span>
                  </span>
                );
                const filterBtn = (val: Severity | "all", text: string) => (
                  <button
                    type="button"
                    data-testid={`triage-filter-${val}`}
                    onClick={() => setSevFilter(val)}
                    style={{
                      padding: "0.2rem 0.6rem", borderRadius: 999, fontSize: "0.72rem", fontWeight: 600, cursor: "pointer",
                      background: sevFilter === val ? "var(--wp-gold, #e8b528)" : "transparent",
                      color: sevFilter === val ? "var(--wp-dark, #0b0d11)" : "var(--wp-text-muted, #9ca3af)",
                      border: "1px solid var(--wp-dark-border, #333)",
                    }}
                  >
                    {text}
                  </button>
                );
                const groupHeading = (sev: Severity, n: number) => (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", margin: "0.2rem 0 0.1rem" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 999, background: sevMeta[sev].color }} />
                    <span style={{ ...label, color: sevMeta[sev].color }}>{sevMeta[sev].label}</span>
                    <span style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)" }}>{n}</span>
                  </div>
                );
                return (
                  <>
                    <div data-testid="triage-summary" style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 1.1rem", alignItems: "center" }}>
                      {chip("var(--wp-error, #ef4444)", c.hostile, "hostile")}
                      {chip("var(--wp-warning, #f5a623)", c.elevated, "elevated")}
                      {chip("var(--wp-success, #30a46c)", c.benign, "benign / neutral")}
                      <span style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)" }}>{c.proven} proven &middot; {c.inferred} inferred</span>
                    </div>
                    <div data-testid="triage-filter" style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
                      {filterBtn("all", "All")}
                      {filterBtn("hostile", "Threats")}
                      {filterBtn("elevated", "Elevated")}
                      {filterBtn("benign", "Benign")}
                      <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)", cursor: "pointer", marginLeft: "0.3rem" }}>
                        <input type="checkbox" data-testid="triage-proven-only" checked={provenOnly} onChange={(e) => setProvenOnly(e.target.checked)} />
                        Proven only
                      </label>
                      {dismissedCount > 0 && (
                        <button
                          type="button"
                          data-testid="triage-show-dismissed"
                          onClick={() => setShowDismissed((v) => !v)}
                          style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--wp-text-muted, #9ca3af)", fontSize: "0.72rem", fontWeight: 600, cursor: "pointer", padding: 0 }}
                        >
                          {showDismissed ? "Hide" : "Show"} {dismissedCount} dismissed
                        </button>
                      )}
                    </div>

                    {show("hostile") && hostile.length > 0 && (
                      <div data-testid="triage-group-hostile">
                        {groupHeading("hostile", hostile.length)}
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.6rem" }}>{hostile.map(renderJourneyCard)}</ul>
                      </div>
                    )}
                    {show("elevated") && elevated.length > 0 && (
                      <div data-testid="triage-group-elevated">
                        {groupHeading("elevated", elevated.length)}
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.6rem" }}>{elevated.map(renderJourneyCard)}</ul>
                      </div>
                    )}
                    {show("benign") && benign.length > 0 && (
                      <div data-testid="triage-group-benign">
                        {sevFilter === "benign" ? (
                          groupHeading("benign", benign.length)
                        ) : (
                          <button
                            type="button"
                            data-testid="triage-benign-toggle"
                            onClick={() => setShowBenign((v) => !v)}
                            style={{ background: "transparent", border: "none", color: "var(--wp-text-muted, #9ca3af)", fontSize: "0.76rem", fontWeight: 600, cursor: "pointer", padding: "0.2rem 0" }}
                          >
                            {showBenign ? "\u25be Hide" : "\u25b8 Show"} {benign.length} benign / neutral
                          </button>
                        )}
                        {(sevFilter === "benign" || showBenign) && (
                          <ul data-testid="triage-benign-list" style={{ listStyle: "none", margin: "0.3rem 0 0", padding: 0, display: "grid", gap: "0.6rem" }}>{benign.map(renderJourneyCard)}</ul>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const RISK_COLOR: Record<string, string> = {
  benign: "var(--wp-success, #30a46c)",
  elevated: "var(--wp-warning, #f5a623)",
  dangerous: "var(--wp-error, #ef4444)",
};

/**
 * Agent profile panel: the granular, honest evidence card for one journey.
 * Everything shown is derived server-side from the same engine that builds a
 * probe/harness dossier, so it never overclaims. It surfaces WHY the verdict,
 * the observed processes (with what each means), the scaffolding read (with its
 * observability caveat), the honestly-limited tool read, the durable operator
 * fingerprint, and the not-a-real-identity disclaimer.
 */
function AgentProfilePanel({ profile, testKey }: { profile: AgentProfile; testKey: string }) {
  const sectionLabel: React.CSSProperties = {
    fontSize: "0.66rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--wp-text-muted, #9ca3af)",
    fontWeight: 700,
    margin: "0 0 0.35rem",
  };
  const box: React.CSSProperties = {
    background: "var(--wp-dark, #0b0d11)",
    border: "1px solid var(--wp-dark-border, #333)",
    borderRadius: 6,
    padding: "0.65rem 0.75rem",
  };
  const mono: React.CSSProperties = { fontFamily: "var(--wp-mono, ui-monospace, monospace)", fontSize: "0.74rem" };

  return (
    <div
      data-testid={`ff-journey-profile-${testKey}`}
      style={{ marginTop: "0.7rem", display: "grid", gap: "0.7rem", borderTop: "1px solid var(--wp-dark-border, #333)", paddingTop: "0.7rem" }}
    >
      {/* Novel conclusions (impersonation, deliberate violation) - the higher-order tells */}
      {profile.insights.length > 0 && (
        <div style={{ ...box, borderColor: "var(--wp-error, #ef4444)" }} data-testid={`insights-${testKey}`}>
          <p style={{ ...sectionLabel, color: "var(--wp-error, #ef4444)" }}>Novel conclusions</p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.4rem" }}>
            {profile.insights.map((ins) => (
              <li key={ins.kind} style={{ fontSize: "0.78rem", color: "var(--wp-text, #eee)", lineHeight: 1.5 }}>
                <strong style={{ color: ins.kind === "deliberate_violation" ? "var(--wp-warning, #f5a623)" : "var(--wp-error, #ef4444)" }}>
                  {ins.kind === "impersonation" ? `Impersonation of ${ins.claimedAgent}: ` : ins.kind === "payload_attack" ? `Active ${ins.attack.replace(/_/g, " ")} payload: ` : "Deliberate rule violation: "}
                </strong>
                {ins.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Why the verdict */}
      <div style={box}>
        <p style={sectionLabel}>Why this verdict</p>
        <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--wp-text, #eee)", lineHeight: 1.5 }}>{profile.verdict.why}</p>
      </div>

      {/* Observed processes */}
      <div style={box}>
        <p style={sectionLabel}>Observed processes</p>
        {profile.processes.length === 0 ? (
          <p style={{ margin: 0, fontSize: "0.76rem", color: "var(--wp-text-muted, #9ca3af)" }}>No distinctive processes observed yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.4rem" }}>
            {profile.processes.map((p) => (
              <li key={p.signal} style={{ display: "grid", gap: "0.1rem" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                  <span
                    style={{
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      color: p.hostile ? "var(--wp-error, #ef4444)" : "var(--wp-text, #eee)",
                    }}
                  >
                    {p.label}
                  </span>
                  {p.hostile && (
                    <span style={{ fontSize: "0.58rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-error, #ef4444)", border: "1px solid var(--wp-error, #ef4444)", borderRadius: 999, padding: "0 0.35rem" }}>
                      hostile
                    </span>
                  )}
                </span>
                <span style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.45 }}>{p.meaning}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Scaffolding read + tooling side by side on wide screens */}
      <div style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <div style={box}>
          <p style={sectionLabel}>Scaffolding (how it is built)</p>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.15rem 0.6rem", fontSize: "0.74rem" }}>
            <dt style={{ color: "var(--wp-text-muted, #9ca3af)" }}>Path discovery</dt>
            <dd style={{ margin: 0, color: "var(--wp-text, #eee)" }}>{profile.scaffolding.pathDiscovery}</dd>
            <dt style={{ color: "var(--wp-text-muted, #9ca3af)" }}>Reads robots first</dt>
            <dd style={{ margin: 0, color: "var(--wp-text, #eee)" }}>{profile.scaffolding.readsRobotsFirst ? "yes" : "no"}</dd>
            <dt style={{ color: "var(--wp-text-muted, #9ca3af)" }}>Probed sensitive</dt>
            <dd style={{ margin: 0, color: "var(--wp-text, #eee)" }}>{profile.scaffolding.probedSensitive ? "yes" : "no"}</dd>
            <dt style={{ color: "var(--wp-text-muted, #9ca3af)" }}>Requests</dt>
            <dd style={{ margin: 0, color: "var(--wp-text, #eee)" }}>{profile.scaffolding.requestCount}</dd>
            <dt style={{ color: "var(--wp-text-muted, #9ca3af)" }}>Span</dt>
            <dd style={{ margin: 0, color: "var(--wp-text, #eee)" }}>{profile.scaffolding.spanSeconds}s</dd>
          </dl>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.68rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.4, fontStyle: "italic" }}>
            {profile.scaffolding.observability}
          </p>
        </div>

        <div style={box}>
          <p style={sectionLabel}>Tooling (what an HTTP exchange proves)</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginBottom: "0.4rem" }}>
            {profile.toolComposition.usedTools.map((t) => (
              <span key={t} style={{ ...mono, background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)", borderRadius: 4, padding: "0.05rem 0.35rem", color: "var(--wp-text, #eee)" }}>
                {t}
              </span>
            ))}
          </div>
          {profile.toolComposition.riskTier === "benign" ? (
            // Not a verdict on the agent: only a benign tool (fetch) is provable
            // over passive HTTP. A green "benign" next to a hostile finding reads
            // as a contradiction, so state plainly that the finding comes from
            // behavior, not from this thin observable toolset.
            <p data-testid="tooling-caveat" style={{ margin: 0, fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.45, fontStyle: "italic" }}>
              No dangerous tool is visible over HTTP (an agent&rsquo;s internal tools are not observable from the outside), so this is not a verdict on the agent. The verdict comes from the behavior above, not the toolset.
            </p>
          ) : (
            // Elevated / dangerous tooling IS meaningful - surface it.
            <p style={{ margin: 0, fontSize: "0.74rem", color: "var(--wp-text, #eee)", lineHeight: 1.45 }}>
              <span style={{ color: RISK_COLOR[profile.toolComposition.riskTier] ?? "var(--wp-text, #eee)", fontWeight: 700 }}>
                {profile.toolComposition.riskTier}
              </span>{" "}
              &middot; {profile.toolComposition.summary}
            </p>
          )}
          {profile.policies.length > 0 && (
            <p style={{ margin: "0.4rem 0 0", fontSize: "0.7rem", color: "var(--wp-error, #ef4444)" }}>
              Policy: {profile.policies.join(", ")}
            </p>
          )}
        </div>
      </div>

      {/* Operator fingerprint + disclaimer */}
      <div style={box}>
        <p style={sectionLabel}>Operator fingerprint</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 1.2rem", alignItems: "baseline" }}>
          <span style={{ ...mono, color: "var(--wp-gold, #e8b528)", fontWeight: 700 }} data-testid={`ff-operator-key-${testKey}`}>
            {profile.operatorKey}
          </span>
          <span style={{ fontSize: "0.68rem", color: "var(--wp-text-muted, #9ca3af)" }}>
            durable behavioral bucket (scaffolding + observed toolset)
          </span>
        </div>
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.68rem", color: "var(--wp-text-muted, #9ca3af)", lineHeight: 1.45 }}>{profile.disclaimer}</p>
      </div>
    </div>
  );
}
