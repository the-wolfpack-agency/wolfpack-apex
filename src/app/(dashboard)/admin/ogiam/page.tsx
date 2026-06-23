"use client";

/**
 * /admin/ogiam: "AI Gateway decisions" (OGIAM) explorer.
 *
 * Read surface over the ogiam_decisions ledger. In Phase 0 the gate runs in
 * shadow mode: it records what it WOULD have decided for every AI action the
 * assistant took, without blocking. This page shows that evidence stream so a
 * CTO can see, per workspace, what enforcement would have stopped.
 *
 * Auth: every fetch goes through fetchWithRefresh (15-min access TTL, HttpOnly
 * refresh rotation). The route is gated on settings.manage_team.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

interface DecisionRow {
  id: string;
  created_at: string;
  principal_agent: string;
  on_behalf_user_id: string;
  on_behalf_role: string | null;
  tool: string;
  capability: string;
  is_mutation: boolean;
  surface: string | null;
  risk_tier: string;
  intended_outcome: string;
  effective_outcome: string;
  enforced: boolean;
  would_block: boolean;
  rule_id: string;
  reason: string | null;
  policy_version: string;
}

interface DecisionSummary {
  total: number;
  would_block: number;
  by_tier: Record<string, number>;
  by_outcome: Record<string, number>;
}

interface DecisionsResponse {
  workspace_id: string;
  summary: DecisionSummary;
  decisions: DecisionRow[];
}

interface ChainVerification {
  ok: boolean;
  verifiedCount: number;
  legacyCount: number;
  brokenAtSeq: number | null;
  headSeq: number;
  headHash: string | null;
}

interface ChainCheckpoint {
  id: string;
  workspaceId: string;
  throughSeq: number;
  headHash: string;
  algorithm: string;
  keyId: string;
  signed: boolean;
  signedAt: string | null;
  createdAt: string;
}

interface VerifyResponse {
  workspace_id: string;
  verification: ChainVerification;
  checkpoint: ChainCheckpoint | null;
}

/* Key ids can be a full Key Vault URL (.../keys/<name>) or a short local label.
   Show the trailing segment so the banner reads "by ogiam-key" rather than a
   200-char URL. */
function shortKeyId(keyId: string): string {
  if (!keyId) return "unknown key";
  const parts = keyId.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? keyId;
}

const TIER_ORDER = ["critical", "high", "medium", "low"] as const;

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/* Risk-tier chip colors. Tuned to read on the dark surface without hard-coding
   outside the var(--wp-*) fallbacks the rest of the dashboard uses. */
function tierColor(tier: string): { fg: string; bg: string } {
  switch (tier) {
    case "critical":
      return { fg: "#ef4444", bg: "rgba(239,68,68,0.12)" };
    case "high":
      return { fg: "#f97316", bg: "rgba(249,115,22,0.12)" };
    case "medium":
      return { fg: "var(--wp-gold, #f1c233)", bg: "rgba(241,194,51,0.12)" };
    default:
      return { fg: "var(--wp-text-dim, #aaa)", bg: "rgba(160,160,160,0.10)" };
  }
}

export default function OgiamPage() {
  const [rows, setRows] = useState<DecisionRow[]>([]);
  const [summary, setSummary] = useState<DecisionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wouldBlockOnly, setWouldBlockOnly] = useState(false);
  const [chain, setChain] = useState<VerifyResponse | null>(null);

  const loadChain = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/ogiam/verify");
      if (!res.ok) {
        // The banner is supplementary; a failed verify fetch just hides it
        // rather than blocking the decisions list below.
        setChain(null);
        return;
      }
      setChain((await res.json()) as VerifyResponse);
    } catch {
      setChain(null);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = wouldBlockOnly ? "?limit=200&would_block=1" : "?limit=200";
      const res = await fetchWithRefresh(`/api/admin/ogiam/decisions${qs}`);
      if (!res.ok) {
        if (res.status === 403) {
          setError("You don't have permission to view AI Gateway decisions.");
        } else {
          setError(`Could not load decisions (HTTP ${res.status}).`);
        }
        setRows([]);
        setSummary(null);
        return;
      }
      const body = (await res.json()) as DecisionsResponse;
      setRows(body.decisions ?? []);
      setSummary(body.summary ?? null);
    } catch (e) {
      setError((e as Error).message || "Network error");
      setRows([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [wouldBlockOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadChain();
  }, [loadChain]);

  return (
    <div
      data-testid="admin-ogiam-page"
      style={{
        padding: "2rem 1.5rem",
        maxWidth: "920px",
        margin: "0 auto",
        color: "var(--wp-text, #eee)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.5rem", color: "var(--wp-gold, #f1c233)" }}>
          AI Gateway decisions
        </h1>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{
            background: "var(--wp-dark-surface2, #1a1a1a)",
            color: "var(--wp-text-dim, #aaa)",
            border: "1px solid var(--wp-dark-border, #333)",
            borderRadius: "6px",
            padding: "0.4rem 0.9rem",
            fontSize: "0.85rem",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <p
        data-testid="ogiam-shadow-banner"
        style={{
          color: "var(--wp-text-muted, #6b7280)",
          margin: "0 0 1rem 0",
          fontSize: "0.85rem",
        }}
      >
        Shadow mode: monitoring, not blocking. Every action below was allowed to
        run; the gate records what it would have decided.
      </p>

      {chain && (() => {
        const v = chain.verification;
        const cp = chain.checkpoint;
        const failed = !v.ok;
        const fg = failed
          ? "var(--wp-error, #ef4444)"
          : "var(--wp-success, #22c55e)";
        const bg = failed
          ? "rgba(239,68,68,0.08)"
          : "rgba(34,197,94,0.08)";
        return (
          <div
            data-testid="ogiam-chain-status"
            style={{
              padding: "0.7rem 1rem",
              marginBottom: "1.25rem",
              background: bg,
              border: `1px solid ${fg}`,
              borderRadius: "8px",
              fontSize: "0.82rem",
            }}
          >
            {failed ? (
              <div style={{ color: fg, fontWeight: 600 }}>
                Chain integrity check FAILED at sequence {v.brokenAtSeq ?? "?"}
              </div>
            ) : (
              <>
                <div style={{ color: fg, fontWeight: 600 }}>
                  Chain verified: {v.verifiedCount} decisions, head sequence{" "}
                  {v.headSeq}
                </div>
                <div
                  style={{
                    marginTop: "0.25rem",
                    color: "var(--wp-text-dim, #aaa)",
                  }}
                >
                  {cp && cp.signed ? (
                    <>
                      Notarized through sequence {cp.throughSeq}, signed{" "}
                      {relativeTime(cp.signedAt)} by {shortKeyId(cp.keyId)}
                    </>
                  ) : (
                    <>Tamper-evident, notarization not yet configured</>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {summary && (
        <div
          data-testid="ogiam-summary"
          style={{
            display: "flex",
            gap: "1rem",
            flexWrap: "wrap",
            marginBottom: "1.25rem",
          }}
        >
          <div
            data-testid="ogiam-summary-total"
            style={{
              flex: "1 1 160px",
              padding: "0.9rem 1rem",
              background: "var(--wp-dark-surface, #1f1f22)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "8px",
            }}
          >
            <div style={{ fontSize: "1.6rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
              {summary.total}
            </div>
            <div style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #aaa)" }}>
              actions gated
            </div>
          </div>
          <div
            data-testid="ogiam-summary-would-block"
            style={{
              flex: "1 1 160px",
              padding: "0.9rem 1rem",
              background: "var(--wp-dark-surface, #1f1f22)",
              border: `1px solid ${summary.would_block > 0 ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`,
              borderRadius: "8px",
            }}
          >
            <div
              style={{
                fontSize: "1.6rem",
                fontWeight: 700,
                color: summary.would_block > 0 ? "var(--wp-gold, #f1c233)" : "var(--wp-text, #eee)",
              }}
            >
              {summary.would_block}
            </div>
            <div style={{ fontSize: "0.8rem", color: "var(--wp-text-dim, #aaa)" }}>
              would have been blocked
            </div>
          </div>
          <div
            data-testid="ogiam-summary-by-tier"
            style={{
              flex: "2 1 280px",
              padding: "0.9rem 1rem",
              background: "var(--wp-dark-surface, #1f1f22)",
              border: "1px solid var(--wp-dark-border, #333)",
              borderRadius: "8px",
            }}
          >
            <div style={{ fontSize: "0.75rem", color: "var(--wp-text-muted, #6b7280)", marginBottom: "0.4rem" }}>
              By risk tier
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {TIER_ORDER.filter((t) => (summary.by_tier[t] ?? 0) > 0).length === 0 ? (
                <span style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}>
                  No decisions yet
                </span>
              ) : (
                TIER_ORDER.filter((t) => (summary.by_tier[t] ?? 0) > 0).map((t) => {
                  const c = tierColor(t);
                  return (
                    <span
                      key={t}
                      data-testid={`ogiam-tier-count-${t}`}
                      style={{
                        padding: "0.15rem 0.55rem",
                        borderRadius: "10px",
                        fontSize: "0.75rem",
                        background: c.bg,
                        color: c.fg,
                        border: `1px solid ${c.fg}`,
                        textTransform: "capitalize",
                      }}
                    >
                      {t} {summary.by_tier[t]}
                    </span>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
        <button
          type="button"
          data-testid="ogiam-filter-would-block"
          onClick={() => setWouldBlockOnly((v) => !v)}
          aria-pressed={wouldBlockOnly}
          style={{
            padding: "0.35rem 0.9rem",
            borderRadius: "6px",
            fontSize: "0.85rem",
            cursor: "pointer",
            background: wouldBlockOnly ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-surface, #1f1f22)",
            color: wouldBlockOnly ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
            border: `1px solid ${wouldBlockOnly ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`,
            fontWeight: wouldBlockOnly ? 600 : 400,
          }}
        >
          {wouldBlockOnly ? "Showing would-block only" : "Would-block only"}
        </button>
      </div>

      {error && (
        <div
          data-testid="ogiam-decisions-error"
          style={{
            padding: "0.75rem 1rem",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-error, #ef4444)",
            border: "1px solid var(--wp-error, #ef4444)",
            borderRadius: "6px",
            marginBottom: "1rem",
          }}
        >
          {error}
        </div>
      )}

      {!error && !loading && rows.length === 0 && (
        <div
          data-testid="ogiam-decisions-empty"
          style={{
            padding: "1.5rem",
            background: "var(--wp-dark-surface, #1f1f22)",
            border: "1px dashed var(--wp-dark-border, #333)",
            borderRadius: "8px",
            textAlign: "center",
            color: "var(--wp-text-muted, #6b7280)",
          }}
        >
          {wouldBlockOnly
            ? "Nothing the gate would have blocked yet."
            : "No AI Gateway decisions recorded yet."}
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="ogiam-decisions-list">
        {rows.map((r) => {
          const c = tierColor(r.risk_tier);
          return (
            <li
              key={r.id}
              data-testid={`ogiam-decision-row-${r.id}`}
              style={{
                padding: "1rem 1.1rem",
                marginBottom: "0.5rem",
                background: "var(--wp-dark-surface, #1f1f22)",
                border: `1px solid ${r.would_block ? "var(--wp-gold, #f1c233)" : "var(--wp-dark-border, #333)"}`,
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <div style={{ fontSize: "0.95rem", color: "var(--wp-text, #eee)" }}>
                  <strong>{r.tool}</strong>
                  <span style={{ marginLeft: "0.4rem", color: "var(--wp-text-dim, #aaa)", fontSize: "0.85rem" }}>
                    {r.capability}
                  </span>
                  {r.is_mutation && (
                    <span
                      style={{
                        marginLeft: "0.5rem",
                        padding: "0.05rem 0.4rem",
                        borderRadius: "8px",
                        fontSize: "0.65rem",
                        background: "rgba(160,160,160,0.10)",
                        color: "var(--wp-text-muted, #6b7280)",
                        border: "1px solid var(--wp-dark-border, #333)",
                      }}
                    >
                      mutation
                    </span>
                  )}
                </div>
                <div title={r.created_at} style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #6b7280)" }}>
                  {relativeTime(r.created_at)}
                </div>
              </div>

              <div style={{ marginTop: "0.45rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span
                  data-testid={`ogiam-tier-chip-${r.id}`}
                  style={{
                    padding: "0.1rem 0.5rem",
                    borderRadius: "10px",
                    fontSize: "0.7rem",
                    background: c.bg,
                    color: c.fg,
                    border: `1px solid ${c.fg}`,
                    textTransform: "capitalize",
                  }}
                >
                  {r.risk_tier}
                </span>
                <span style={{ fontSize: "0.78rem", color: "var(--wp-text-dim, #aaa)" }}>
                  intended: <strong style={{ color: "var(--wp-text, #eee)" }}>{r.intended_outcome}</strong>
                </span>
                {r.would_block && (
                  <span
                    data-testid={`ogiam-would-block-badge-${r.id}`}
                    style={{
                      padding: "0.1rem 0.5rem",
                      borderRadius: "10px",
                      fontSize: "0.7rem",
                      background: "rgba(241,194,51,0.12)",
                      color: "var(--wp-gold, #f1c233)",
                      border: "1px solid var(--wp-gold, #f1c233)",
                      fontWeight: 600,
                    }}
                  >
                    would block
                  </span>
                )}
              </div>

              <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--wp-text-dim, #aaa)" }}>
                on behalf of{" "}
                <strong style={{ color: "var(--wp-text, #eee)" }}>{r.on_behalf_user_id}</strong>
                {r.on_behalf_role && (
                  <span style={{ color: "var(--wp-text-muted, #6b7280)" }}> · {r.on_behalf_role}</span>
                )}
                {r.surface && (
                  <span style={{ color: "var(--wp-text-muted, #6b7280)" }}> · from {r.surface}</span>
                )}
              </div>

              <div
                style={{
                  marginTop: "0.4rem",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                  fontSize: "0.7rem",
                  color: "var(--wp-text-muted, #6b7280)",
                }}
              >
                <span data-testid={`ogiam-rule-${r.id}`}>rule {r.rule_id}</span>
                {r.reason && <span style={{ fontStyle: "italic" }}>{r.reason}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
