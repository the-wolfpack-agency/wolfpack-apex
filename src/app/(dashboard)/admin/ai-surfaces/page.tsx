"use client";

/**
 * /admin/ai-surfaces: the AI Surface Inventory (shadow-AI discovery).
 *
 * The "you cannot govern what you cannot see" view: every discovered AI
 * touchpoint (model SDK call, provider endpoint, AI key, MCP server) with the
 * ungoverned ones surfaced as the headline gap. This is demo beat 1 and the
 * free-scan wedge's screen.
 *
 * Read surface over GET /api/admin/ai-surfaces (workspace-scoped, gated on
 * settings.manage_team). Every fetch goes through fetchWithRefresh; the
 * (dashboard) layout enforces the authenticated shell, so an expired session is
 * rotated or redirected to /login rather than rendering blank.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  ConsoleGrid,
  GlassPanel,
  MetricTile,
  SectionHeader,
  StatusPill,
  TONE_VAR,
} from "@/components/console";

interface Surface {
  id: string;
  target: string;
  kind: string;
  provider: string;
  location: string;
  governed: boolean;
  risk: string;
  evidence: Record<string, string | number | boolean | null>;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface Summary {
  total: number;
  ungoverned: number;
  byKind: Record<string, number>;
  byProvider: Record<string, number>;
  byRisk: Record<string, number>;
}

interface Remediation {
  kind: string;
  provider: string;
  summary: string;
  steps: string[];
  snippet: string;
  priority: string;
}

interface InventoryResponse {
  surfaces: Surface[];
  summary: Summary;
}

const KIND_LABEL: Record<string, string> = {
  ai_sdk: "Model SDK call",
  provider_endpoint: "Provider endpoint",
  api_key: "AI key",
  ai_route: "AI route",
  mcp_server: "MCP server",
};

function countOf(rec: Record<string, number> | undefined, key: string): number {
  return rec?.[key] ?? 0;
}

/** Deterministic key tying a surface row to its remediation (kind + provider). */
function remKey(kind: string, provider: string): string {
  return `${kind}::${provider}`;
}

export default function AiSurfacesPage() {
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [ungovernedOnly, setUngovernedOnly] = useState(false);

  // Live repo-scan state.
  const [repoUrl, setRepoUrl] = useState("");
  const [scanState, setScanState] = useState<"idle" | "scanning" | "error">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [remediations, setRemediations] = useState<Remediation[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetchWithRefresh(
        `/api/admin/ai-surfaces${ungovernedOnly ? "?ungoverned=true" : ""}`,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      setData((await res.json()) as InventoryResponse);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [ungovernedOnly]);

  const scanRepo = useCallback(async () => {
    const url = repoUrl.trim();
    if (!url) return;
    setScanState("scanning");
    setScanError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/ai-surfaces/repo-scan", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ url }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        result?: { remediations?: Remediation[] };
        error?: string;
      };
      if (!res.ok) {
        setScanError(body.error ?? `Scan failed (status ${res.status})`);
        setScanState("error");
        return;
      }
      setRemediations(body.result?.remediations ?? []);
      setScanState("idle");
      // Refresh the inventory so the freshly-discovered surfaces render.
      await load();
    } catch {
      setScanError("Could not reach the scan service. Retry, or check your session.");
      setScanState("error");
    }
  }, [repoUrl, load]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = data?.summary;
  const providers = useMemo(() => Object.keys(summary?.byProvider ?? {}).length, [summary]);
  const criticalRisk = countOf(summary?.byRisk, "critical");
  const remByKey = useMemo(() => {
    const m = new Map<string, Remediation>();
    for (const r of remediations) m.set(remKey(r.kind, r.provider), r);
    return m;
  }, [remediations]);

  return (
    <div data-testid="ai-surfaces-root" className="mx-auto max-w-7xl px-6 py-10 lg:px-8">
      <SectionHeader
        eyebrow="AI Governance"
        title="AI Surface Inventory"
        subtitle="Every place AI touches your systems, including the ungoverned ones."
        actions={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setUngovernedOnly((v) => !v)}
              className="rounded-md border border-hairline px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
              aria-pressed={ungovernedOnly}
            >
              {ungovernedOnly ? "Showing ungoverned" : "Show ungoverned only"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-hairline px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
            >
              Refresh
            </button>
          </div>
        }
      />

      <GlassPanel
        className="mt-8"
        title="Scan a public repo"
        subtitle="Paste a public GitHub repo URL to discover its AI surfaces live."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="url"
            inputMode="url"
            data-testid="repo-scan-url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void scanRepo();
            }}
            placeholder="https://github.com/owner/repo"
            className="flex-1 rounded-md border border-hairline bg-transparent px-3 py-2 font-mono text-[13px] text-ink placeholder:text-muted focus:border-ink-soft focus:outline-none"
            aria-label="Public GitHub repo URL"
          />
          <button
            type="button"
            data-testid="repo-scan-button"
            onClick={() => void scanRepo()}
            disabled={scanState === "scanning" || repoUrl.trim() === ""}
            className="rounded-md border border-hairline px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {scanState === "scanning" ? "Scanning…" : "Scan repo"}
          </button>
        </div>
        {scanState === "error" && (
          <p data-testid="repo-scan-error" className="mt-3 text-sm" style={{ color: TONE_VAR.error }}>
            {scanError}
          </p>
        )}
      </GlassPanel>

      {state === "error" && (
        <p data-testid="ai-surfaces-error" className="mt-8 text-sm text-muted">
          Could not load the inventory. Retry, or check that your session is active.
        </p>
      )}

      {state !== "error" && (
        <>
          <ConsoleGrid testId="ai-surfaces-summary" className="mt-8">
            <MetricTile label="AI surfaces" value={summary?.total ?? 0} />
            <MetricTile
              label="Ungoverned"
              value={summary?.ungoverned ?? 0}
              accent={summary && summary.ungoverned > 0 ? TONE_VAR.error : undefined}
            />
            <MetricTile label="Critical-risk" value={criticalRisk} accent={criticalRisk > 0 ? TONE_VAR.error : undefined} />
            <MetricTile label="Providers" value={providers} />
          </ConsoleGrid>

          <GlassPanel
            className="mt-8"
            title="Discovered surfaces"
            subtitle={
              state === "loading"
                ? "Loading…"
                : `${data?.surfaces.length ?? 0} touchpoint(s)`
            }
          >
            {state === "ready" && (data?.surfaces.length ?? 0) === 0 ? (
              <p data-testid="ai-surfaces-empty" className="py-6 text-sm text-muted">
                No AI surfaces discovered yet. Run a discovery scan over a connected
                source to populate the inventory.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                    <tr>
                      <th className="py-2 pr-4">Kind</th>
                      <th className="py-2 pr-4">Provider</th>
                      <th className="py-2 pr-4">Risk</th>
                      <th className="py-2 pr-4">Governed</th>
                      <th className="py-2 pr-4">Location</th>
                      <th className="py-2 pr-4">Fix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.surfaces ?? []).map((s) => {
                      const rem = !s.governed ? remByKey.get(remKey(s.kind, s.provider)) : undefined;
                      const isOpen = expanded === s.id;
                      return (
                        <Fragment key={s.id}>
                          <tr data-testid="ai-surface-row" className="border-t border-hairline">
                            <td className="py-2.5 pr-4 text-ink-soft">{KIND_LABEL[s.kind] ?? s.kind}</td>
                            <td className="py-2.5 pr-4 text-ink-soft">{s.provider}</td>
                            <td className="py-2.5 pr-4">
                              <StatusPill status={s.risk} />
                            </td>
                            <td className="py-2.5 pr-4">
                              <StatusPill
                                status={s.governed ? "governed" : "ungoverned"}
                                tone={s.governed ? "success" : "warning"}
                              />
                            </td>
                            <td className="py-2.5 pr-4 font-mono text-[12px] text-muted">{s.location}</td>
                            <td className="py-2.5 pr-4">
                              {rem ? (
                                <button
                                  type="button"
                                  data-testid="remediation-toggle"
                                  aria-expanded={isOpen}
                                  onClick={() => setExpanded(isOpen ? null : s.id)}
                                  className="rounded-md border border-hairline px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-ink"
                                >
                                  {isOpen ? "Hide fix" : "How to govern"}
                                </button>
                              ) : (
                                <span className="text-muted">—</span>
                              )}
                            </td>
                          </tr>
                          {rem && isOpen && (
                            <tr data-testid="remediation-row" className="border-t border-hairline">
                              <td colSpan={6} className="py-3 pr-4">
                                <p className="mb-2 text-[13px] text-ink-soft">{rem.summary}</p>
                                <ol className="mb-3 list-decimal space-y-1 pl-5 text-[12.5px] text-muted">
                                  {rem.steps.map((step, i) => (
                                    <li key={i}>{step}</li>
                                  ))}
                                </ol>
                                <pre className="overflow-x-auto rounded-md border border-hairline p-3 font-mono text-[11.5px] text-ink-soft">
                                  {rem.snippet}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </GlassPanel>
        </>
      )}
    </div>
  );
}
