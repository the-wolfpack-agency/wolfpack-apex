"use client";

/**
 * AgentDeploymentsPanel — the per-agent Deployments tab. Reads GET
 * /api/admin/agents/[id]/deployments: the PRs this agent was dispatched to
 * triage from the release gate (the deploy_gate wiring), each matched to its
 * current pipeline. An in-flight PR renders its full CI -> merge -> build ->
 * promote -> verify -> health timeline (PipelineRow); a PR that has resolved
 * since triage renders a compact merged/closed line rather than disappearing.
 * This is where an operator sees an agent's actual involvement in shipping code.
 * Read-only, honest-degrade, defensive against a malformed body.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, SectionHeader } from "@/components/console";
import { PipelineRow } from "./PipelineRow";
import type { DeploymentPipeline } from "@/lib/deploy/pipeline";

interface Link {
  prNumber: number;
  stateAtTriage: string | null;
  triagedAt: string;
  pipeline: DeploymentPipeline | null;
  resolved: boolean;
}
interface Degrade {
  source: "github" | "vercel";
  detail: string;
}
interface Response {
  ok: boolean;
  links: Link[];
  degraded: Degrade[];
}

type PanelState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "present"; links: Link[]; degraded: Degrade[] };

export function AgentDeploymentsPanel({
  agentId,
  testId = "agent-deployments",
}: {
  agentId: string;
  testId?: string;
}) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh(`/api/admin/agents/${agentId}/deployments`);
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      const body = (await res.json()) as Response;
      if (!body || !Array.isArray(body.links)) {
        setState({ kind: "error" });
        return;
      }
      setState({
        kind: "present",
        links: body.links,
        degraded: Array.isArray(body.degraded) ? body.degraded : [],
      });
    } catch {
      setState({ kind: "error" });
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <GlassPanel testId={testId}>
      <SectionHeader
        title="Deployments this agent touched"
        subtitle="Blocking deploys the agent was dispatched to triage, and where each stands now"
      />

      {state.kind === "loading" && (
        <div data-testid={`${testId}-loading`} style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>
          Loading deployments…
        </div>
      )}

      {state.kind === "error" && (
        <div data-testid={`${testId}-error`} style={{ fontSize: "0.82rem", color: "var(--wp-error, #ef4444)" }}>
          Could not load deployments. Reload to retry.
        </div>
      )}

      {state.kind === "present" && (
        <>
          {state.degraded.length > 0 && (
            <div
              data-testid={`${testId}-degraded`}
              style={{
                fontSize: "0.8rem",
                color: "var(--wp-warning, #f97316)",
                padding: "0.5rem 0.7rem",
                marginBottom: "0.6rem",
                border: "1px solid var(--wp-dark-border, #333)",
                borderRadius: 6,
              }}
            >
              {state.degraded.map((d) => `${d.source}: ${d.detail}`).join(" · ")}
            </div>
          )}

          {state.links.length === 0 ? (
            <div data-testid={`${testId}-empty`} style={{ fontSize: "0.85rem", color: "var(--wp-text-muted, #9ca3af)" }}>
              This agent has not been dispatched to triage any deploys yet. Send one from the release gate on the agents page.
            </div>
          ) : (
            <ul
              data-testid={`${testId}-list`}
              style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}
            >
              {state.links.map((link) =>
                link.pipeline ? (
                  <PipelineRow key={link.prNumber} pipeline={link.pipeline} testId={`${testId}-row-${link.prNumber}`} />
                ) : (
                  <li
                    key={link.prNumber}
                    data-testid={`${testId}-resolved-${link.prNumber}`}
                    style={{
                      listStyle: "none",
                      padding: "0.55rem 0.7rem",
                      borderRadius: 8,
                      background: "var(--wp-dark-surface2, #1a1a1a)",
                      border: "1px solid var(--wp-dark-border, #333)",
                      fontSize: "0.82rem",
                      color: "var(--wp-text-dim, #b4bcc8)",
                    }}
                  >
                    <a
                      href={`https://github.com/the-wolfpack-agency/wolfpack-apex/pull/${link.prNumber}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--wp-text, #eee)", textDecoration: "none", fontWeight: 600 }}
                    >
                      #{link.prNumber}
                    </a>{" "}
                    resolved since triage
                    {link.stateAtTriage ? ` (was ${link.stateAtTriage.replace(/_/g, " ")})` : ""}. Merged or closed.
                  </li>
                ),
              )}
            </ul>
          )}
        </>
      )}
    </GlassPanel>
  );
}

export default AgentDeploymentsPanel;
