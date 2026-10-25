"use client";

/**
 * Proven attacks, per protected site: the top of the Forcefield board.
 *
 * Only events the engine PROVED hostile are counted here (a live payload or a
 * tripped decoy), split blocked vs report-only, with the control-plane false
 * positive already excluded server-side (and its count shown, so nothing is
 * hidden from someone who looks). Flagged / welcomed / page-view volume is
 * context and lives in the panels below.
 *
 * Every state is explicit: gated (no forcefield.view), error (the read failed,
 * never shown as zero), no sites, a site with zero blocked attacks (said
 * plainly, with what to check), and a stale site (stopped reporting).
 * Presentational: the page owns the fetch.
 */
import type { CSSProperties } from "react";
import { GlassPanel, StatusPill } from "@/components/console";
import { attackLabel } from "@/components/AgentJourneyTimeline";
import type { ProvenAttacks, ProvenAttackClass, ProvenModeSummary, ProvenSite } from "@/lib/site-analytics-proven";

/** A site with no event of any kind for this long reads as stale. */
export const PROVEN_STALE_MS = 24 * 60 * 60 * 1000;

const muted: CSSProperties = { fontSize: "0.76rem", color: "var(--wp-text-muted, #9ca3af)", margin: 0, lineHeight: 1.5 };
const sub: CSSProperties = { fontSize: "0.66rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--wp-text-muted, #9ca3af)", margin: 0 };
const th: CSSProperties = { textAlign: "left", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #9ca3af)", padding: "0.3rem 0.5rem", borderBottom: "1px solid var(--wp-dark-border, #262a33)", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "0.35rem 0.5rem", fontSize: "0.8rem", color: "var(--wp-text, #eee)", borderBottom: "1px solid var(--wp-dark-border, #1d2129)", verticalAlign: "top" };

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function classLabel(c: ProvenAttackClass): string {
  return c.eventType === "site.agent_trap_tripped" ? "Decoy trip" : attackLabel(c.attack);
}

/** "fingerprint not recorded" when none was, never a misleading 0. */
function FingerprintCell({ fingerprints, withoutFingerprint, testId }: { fingerprints: number | null; withoutFingerprint: number; testId: string }) {
  if (fingerprints === null) {
    return <span data-testid={testId} style={{ color: "var(--wp-text-muted, #9ca3af)", fontStyle: "italic" }}>fingerprint not recorded</span>;
  }
  return (
    <span data-testid={testId}>
      {fingerprints.toLocaleString()}
      {withoutFingerprint > 0 && (
        <span style={{ color: "var(--wp-text-muted, #9ca3af)" }}> (+{withoutFingerprint.toLocaleString()} without fingerprint)</span>
      )}
    </span>
  );
}

function ModeTable({ site, mode, data, now }: { site: string; mode: "blocked" | "report-only"; data: ProvenModeSummary; now: number }) {
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table data-testid={`proven-${site}-${mode}-table`} style={{ width: "100%", borderCollapse: "collapse", minWidth: 0 }}>
        <thead>
          <tr>
            <th style={th}>Attack class</th>
            <th style={{ ...th, textAlign: "right" }}>Events</th>
            <th style={th}>Distinct fingerprints</th>
            <th style={th}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data.byClass.map((c) => (
            <tr key={`${c.eventType}:${c.attack}`} data-testid={`proven-${site}-${mode}-${c.attack}`}>
              <td style={td}>{classLabel(c)}</td>
              <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{c.count.toLocaleString()}</td>
              <td style={td}><FingerprintCell fingerprints={c.fingerprints} withoutFingerprint={c.withoutFingerprint} testId={`proven-${site}-${mode}-${c.attack}-fp`} /></td>
              <td style={{ ...td, whiteSpace: "nowrap" }} title={c.lastSeen ?? undefined}>{ago(c.lastSeen, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SiteCard({ s, rangeDays, now }: { s: ProvenSite; rangeDays: number; now: number }) {
  const lastReport = s.lastReportAt ? Date.parse(s.lastReportAt) : NaN;
  const stale = !Number.isFinite(lastReport) || now - lastReport > PROVEN_STALE_MS;
  const RED = "var(--wp-error, #ef4444)";
  return (
    <div
      data-testid={`proven-site-${s.site}`}
      style={{ border: "1px solid var(--wp-dark-border, #262a33)", borderLeft: `3px solid ${s.blocked.events > 0 ? RED : "var(--wp-dark-border, #333)"}`, borderRadius: 8, padding: "0.8rem 0.9rem", display: "grid", gap: "0.65rem", minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--wp-mono, ui-monospace, monospace)", fontWeight: 800, fontSize: "0.95rem", color: "var(--wp-text, #eee)" }}>{s.site}</span>
        <span data-testid={`proven-site-${s.site}-blocked-count`} style={{ fontWeight: 800, color: s.blocked.events > 0 ? RED : "var(--wp-text-muted, #9ca3af)" }}>
          {s.blocked.events.toLocaleString()} blocked
        </span>
        <span data-testid={`proven-site-${s.site}-report-only-count`} style={{ color: "var(--wp-text-muted, #9ca3af)", fontSize: "0.8rem" }}>
          {s.reportOnly.events.toLocaleString()} report-only
        </span>
        {s.blocked.events > 0 && (
          <span style={{ fontSize: "0.74rem", color: "var(--wp-text-muted, #9ca3af)" }}>
            fingerprints: <FingerprintCell fingerprints={s.blocked.fingerprints} withoutFingerprint={s.blocked.withoutFingerprint} testId={`proven-site-${s.site}-blocked-fp`} />
            {" "}&middot; last blocked {ago(s.blocked.lastSeen, now)}
          </span>
        )}
        {stale && (
          <StatusPill
            status="warning"
            tone="warning"
            size="sm"
            testId={`proven-site-${s.site}-stale`}
            label={s.lastReportAt ? `stale: last event ${ago(s.lastReportAt, now)}` : `stale: no events in ${rangeDays}d`}
          />
        )}
      </div>

      <div style={{ display: "grid", gap: "0.35rem" }}>
        <p style={sub}>Blocked</p>
        {s.blocked.events === 0 ? (
          <p data-testid={`proven-site-${s.site}-empty`} style={{ ...muted, color: "var(--wp-warning, #f5a623)" }}>
            No blocked attacks reported in {rangeDays} days. If this site enforces, check that it reports blocks.
          </p>
        ) : (
          <ModeTable site={s.site} mode="blocked" data={s.blocked} now={now} />
        )}
      </div>

      <div style={{ display: "grid", gap: "0.35rem" }}>
        <p style={sub}>Report-only (detected, not blocked)</p>
        {s.reportOnly.events === 0 ? (
          <p data-testid={`proven-site-${s.site}-report-only-empty`} style={muted}>No report-only detections in {rangeDays} days.</p>
        ) : (
          <ModeTable site={s.site} mode="report-only" data={s.reportOnly} now={now} />
        )}
      </div>

      {s.excludedFalsePositives > 0 && (
        <p data-testid={`proven-site-${s.site}-excluded`} style={{ ...muted, fontSize: "0.7rem" }}>
          {s.excludedFalsePositives.toLocaleString()} control-plane false positive{s.excludedFalsePositives === 1 ? "" : "s"} excluded: our own edge calls to the Forcefield ingest / ruleset / observe endpoints, once mis-recorded as a Next.js middleware bypass. Fixed at the source; old rows are not counted as attacks.
        </p>
      )}
    </div>
  );
}

export interface ProvenAttacksPanelProps {
  /** Absent for a viewer without forcefield.view (stripped server-side). */
  proven?: ProvenAttacks;
  viewIntel: boolean;
  rangeDays: number;
  /** The high-level, org-wide blocked count, for the gated view. */
  blockedTotal: number;
  /** Injected for tests; defaults to Date.now(). */
  now?: number;
}

export function ProvenAttacksPanel({ proven, viewIntel, rangeDays, blockedTotal, now = Date.now() }: ProvenAttacksPanelProps) {
  const title = <span>Proven attacks &middot; last {rangeDays}d</span>;
  const subtitle = "Blocked payloads and decoy trips per protected site. Flagged, welcomed and page-view traffic is not counted here; it is in the panels below.";

  if (!viewIntel) {
    return (
      <GlassPanel testId="proven-attacks" title={title} glow="gold">
        <p data-testid="proven-attacks-gated" style={muted}>
          {blockedTotal.toLocaleString()} request{blockedTotal === 1 ? "" : "s"} blocked in this window. The per-site breakdown by attack class needs the forcefield.view capability.
        </p>
      </GlassPanel>
    );
  }

  if (!proven || !proven.available) {
    return (
      <GlassPanel testId="proven-attacks" title={title} subtitle={subtitle} glow="gold">
        <p data-testid="proven-attacks-error" role="alert" style={{ ...muted, color: "var(--wp-error, #ef4444)" }}>
          Proven-attack data could not be loaded. This is not a zero: the read failed. Reload the page to retry.
        </p>
      </GlassPanel>
    );
  }

  const totalBlocked = proven.sites.reduce((n, s) => n + s.blocked.events, 0);
  const totalReportOnly = proven.sites.reduce((n, s) => n + s.reportOnly.events, 0);
  return (
    <GlassPanel
      testId="proven-attacks"
      title={title}
      subtitle={subtitle}
      glow="gold"
      actions={
        <span data-testid="proven-attacks-totals" style={{ fontSize: "0.76rem", color: "var(--wp-text-muted, #9ca3af)" }}>
          <strong style={{ color: totalBlocked > 0 ? "var(--wp-error, #ef4444)" : "var(--wp-text, #eee)" }}>{totalBlocked.toLocaleString()}</strong> blocked
          {" "}&middot; {totalReportOnly.toLocaleString()} report-only
        </span>
      }
    >
      <div style={{ display: "grid", gap: "0.8rem" }}>
        {proven.sites.length === 0 ? (
          <p data-testid="proven-attacks-no-sites" style={muted}>
            No protected site reported any event in {rangeDays} days, so there is nothing to show. If a site is meant to be protected, check that its edge is forwarding events.
          </p>
        ) : (
          proven.sites.map((s) => <SiteCard key={s.site} s={s} rangeDays={rangeDays} now={now} />)
        )}
        <p data-testid="proven-attacks-asof" style={{ ...muted, fontSize: "0.68rem" }}>
          As of {new Date(proven.generatedAt).toLocaleString()}.
          {proven.excludedFalsePositives > 0 && ` ${proven.excludedFalsePositives.toLocaleString()} control-plane false-positive rows excluded in total.`}
        </p>
      </div>
    </GlassPanel>
  );
}

export default ProvenAttacksPanel;
