"use client";

/**
 * /admin/ai-router - which models this platform can use, which it chose, and
 * what that is estimated to have cost.
 *
 * WHAT WAS ALREADY THERE
 *
 * The router (lib/ai/models) has chosen a model per call for some time: tiers,
 * pins, cost-weighted selection, a logged reason for every decision. None of it
 * was visible anywhere. A routing engine nobody can see is a set of defaults
 * nobody is checking, so this adds no engine, only the surface over it.
 *
 * ESTIMATED IS NOT BILLED
 *
 * Every cost here is list price times a token estimate formed BEFORE the call
 * ran. It knows nothing about cached input, batch pricing, or what the call
 * actually consumed. The word "estimated" appears on every figure, and the page
 * says out loud when decisions carried no estimate at all — otherwise someone
 * reconciles this against an invoice, finds it wrong, and stops trusting the
 * whole surface.
 *
 * A MODEL THAT IS NOT CONFIGURED SAYS WHICH VARIABLE IS MISSING
 *
 * "Unavailable" sends someone digging. The env var name is the fix, so it is
 * what gets shown.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, SectionHeader, StatusPill, ConsoleGrid } from "@/components/console";
import type { RouterInsights } from "@/lib/ai/models/insights";

/** Accept only well-shaped payloads. A response that is not what we expect must
 *  render as "nothing recorded" rather than throw and blank the page: version
 *  skew during a deploy makes that a real scenario, not a hypothetical. */
function normalize(raw: unknown): RouterInsights | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<RouterInsights>;
  if (!Array.isArray(b.models) || !Array.isArray(b.usage) || !Array.isArray(b.reasons)) return null;
  return {
    days: typeof b.days === "number" ? b.days : 30,
    totalDecisions: b.totalDecisions ?? 0,
    estimatedCostUsd: b.estimatedCostUsd ?? 0,
    decisionsWithoutEstimate: b.decisionsWithoutEstimate ?? 0,
    usage: b.usage,
    reasons: b.reasons,
    fallbacks: b.fallbacks ?? 0,
    models: b.models,
    smallTierShare: typeof b.smallTierShare === "number" ? b.smallTierShare : null,
    headline: typeof b.headline === "string" ? b.headline : "",
  };
}

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

export default function AiRouterPage() {
  const router = useRouter();
  const [data, setData] = useState<RouterInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/ai-router");
      if (!res.ok) {
        setError(`Could not load the router (HTTP ${res.status}).`);
        return;
      }
      setData(normalize(await res.json()));
    } catch {
      setError("Could not reach the router.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Redirect unauthenticated users; never render a blank state.
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/ai-router");
      return;
    }
    void load();
  }, [router, load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <SectionHeader
        as="h1"
        eyebrow="OGIAM"
        title="Model router"
        subtitle="Which models this platform can use, which one it chose for each call, and why."
      />

      {error && (
        <GlassPanel>
          <p role="alert" data-testid="router-error">
            {error}
          </p>
        </GlassPanel>
      )}

      <GlassPanel title="Activity" subtitle={data ? `Last ${data.days} days` : undefined}>
        {loading ? (
          <p style={dim} data-testid="router-loading">
            Checking…
          </p>
        ) : !data ? (
          <p style={dim} data-testid="router-unavailable">
            No routing activity could be read. That is not the same as no activity having happened.
          </p>
        ) : (
          <>
            <p style={{ marginBottom: "0.9rem" }} data-testid="router-headline">
              {data.headline}
            </p>
            <ConsoleGrid minColWidth={180}>
              <MetricTile value={data.totalDecisions} label="Routing decisions" testId="router-metric-decisions" />
              <MetricTile
                display={usd(data.estimatedCostUsd)}
                label="Estimated cost"
                kicker="List price, not billed"
                testId="router-metric-cost"
              />
              <MetricTile
                display={data.smallTierShare === null ? "n/a" : `${Math.round(data.smallTierShare * 100)}%`}
                label="Served by cheapest tier"
                testId="router-metric-cheap"
              />
              <MetricTile value={data.fallbacks} label="Fell back" kicker="Preferred model unavailable" testId="router-metric-fallbacks" />
            </ConsoleGrid>
            {data.decisionsWithoutEstimate > 0 && (
              <p style={notice} data-testid="router-estimate-caveat">
                {data.decisionsWithoutEstimate} decision{data.decisionsWithoutEstimate === 1 ? "" : "s"} carried no cost
                estimate, so the figure above understates the real total.
              </p>
            )}
          </>
        )}
      </GlassPanel>

      {data && data.usage.length > 0 && (
        <GlassPanel title="Which models were used">
          <ul style={list} data-testid="router-usage">
            {data.usage.map((u) => (
              <li key={u.modelId} style={row}>
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{u.modelId}</strong>
                  <StatusPill status={String(u.tier)} size="sm" />
                  <span style={dim}>{u.provider}</span>
                </div>
                <p style={{ ...dim, margin: "0.3rem 0 0" }}>
                  {u.decisions} call{u.decisions === 1 ? "" : "s"}, {usd(u.estimatedCostUsd)} estimated
                  {u.estimated < u.decisions ? ` (${u.decisions - u.estimated} without an estimate)` : ""}
                  {u.fallbacks > 0 ? `, ${u.fallbacks} after a fallback` : ""}.
                </p>
              </li>
            ))}
          </ul>
        </GlassPanel>
      )}

      {data && data.reasons.length > 0 && (
        <GlassPanel title="Why those models were chosen">
          <ul style={list} data-testid="router-reasons">
            {data.reasons.map((r) => (
              <li key={r.reason} style={row}>
                <strong>{r.count}</strong> <span>{r.description}</span>
              </li>
            ))}
          </ul>
        </GlassPanel>
      )}

      {data && (
        <GlassPanel
          title="Models this platform can reach"
          subtitle="Availability is read from the deployment's configuration. It is not editable here: changing which models serve every AI call belongs in a deployment with a review, not a form."
        >
          <ul style={list} data-testid="router-models">
            {data.models.map((m) => (
              <li key={m.modelId} style={row}>
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                  <StatusPill
                    status={m.available ? "available" : "unavailable"}
                    label={m.available ? "Available" : "Not configured"}
                    tone={m.available ? "success" : "neutral"}
                    size="sm"
                  />
                  <strong>{m.modelId}</strong>
                  <span style={dim}>
                    {m.provider} · {m.tier} · {m.contextWindow.toLocaleString()} tokens
                  </span>
                </div>
                <p style={{ ...dim, margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
                  ${m.inputPricePer1kUsd}/1k in, ${m.outputPricePer1kUsd}/1k out
                  {m.blockedBy ? ` — ${m.blockedBy}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </GlassPanel>
      )}
    </div>
  );
}

const dim: React.CSSProperties = { color: "var(--wp-text-dim)", fontSize: "0.9rem" };
const list: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.55rem" };
const row: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.1))",
  borderRadius: "0.6rem",
  padding: "0.65rem 0.8rem",
};
const notice: React.CSSProperties = {
  marginTop: "0.9rem",
  fontSize: "0.85rem",
  color: "var(--wp-text-dim)",
  borderLeft: "2px solid var(--wp-border, rgba(255,255,255,0.2))",
  paddingLeft: "0.7rem",
};
