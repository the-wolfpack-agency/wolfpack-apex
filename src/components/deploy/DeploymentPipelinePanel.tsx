"use client";

/**
 * DeploymentPipelinePanel — the fleet-wide deployment pipeline, surfaced on
 * /admin/deployment beneath the release gate. Reads GET
 * /api/admin/deployment/pipeline and renders each change (recent prod deploys +
 * in-flight PRs) as a full CI -> merge -> build -> promote -> verify -> health
 * timeline via PipelineRow. Read-only: promotion stays the release gate's
 * one-click action above. Honest-degrade aware: a per-source degrade banner is
 * shown instead of a false all-clear (e.g. Vercel token absent -> build/deploy
 * stages could not be read). Defensive against a malformed body so it never
 * blanks the page.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, ConsoleGrid, SectionHeader } from "@/components/console";
import { PipelineRow } from "./PipelineRow";
import type { DeploymentPipeline } from "@/lib/deploy/pipeline";

interface Degrade {
  source: "github" | "vercel";
  detail: string;
}
interface PipelineResponse {
  ok: boolean;
  pipelines: DeploymentPipeline[];
  servingSha: string | null;
  degraded: Degrade[];
}

type PanelState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "present"; pipelines: DeploymentPipeline[]; degraded: Degrade[]; servingSha: string | null };

export function DeploymentPipelinePanel({
  testId = "deployment-pipeline",
}: {
  testId?: string;
}) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/deployment/pipeline");
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      const body = (await res.json()) as PipelineResponse;
      if (!body || !Array.isArray(body.pipelines)) {
        setState({ kind: "error" });
        return;
      }
      setState({
        kind: "present",
        pipelines: body.pipelines,
        degraded: Array.isArray(body.degraded) ? body.degraded : [],
        servingSha: body.servingSha ?? null,
      });
    } catch {
      setState({ kind: "error" });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const pipelines = state.kind === "present" ? state.pipelines : [];
  const failing = pipelines.filter((p) => p.status === "failed").length;
  const inProgress = pipelines.filter((p) => p.status === "in_progress").length;

  return (
    <GlassPanel testId={testId} style={{ marginBottom: "1rem" }}>
      <SectionHeader
        title="Deployment pipeline"
        subtitle="Every change's journey to production: CI, merge, build, promote, verify, health"
      />

      {state.kind === "loading" && (
        <div data-testid={`${testId}-loading`} style={{ fontSize: "0.82rem", color: "var(--wp-text-muted, #9ca3af)" }}>
          Stitching the pipeline…
        </div>
      )}

      {state.kind === "error" && (
        <div data-testid={`${testId}-error`} style={{ fontSize: "0.82rem", color: "var(--wp-error, #ef4444)" }}>
          Could not load the deployment pipeline. Reload to retry.
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

          <ConsoleGrid minColWidth={160} testId={`${testId}-metrics`}>
            <MetricTile testId={`${testId}-total`} label="Changes tracked" value={pipelines.length} accent="var(--wp-text-muted, #9ca3af)" />
            <MetricTile
              testId={`${testId}-failing`}
              label="Failing"
              value={failing}
              accent={failing > 0 ? "var(--wp-error, #ef4444)" : "var(--wp-success, #22c55e)"}
            />
            <MetricTile testId={`${testId}-in-progress`} label="In progress" value={inProgress} accent="var(--wp-info, #3b82f6)" />
          </ConsoleGrid>

          {pipelines.length === 0 ? (
            <div data-testid={`${testId}-empty`} style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "var(--wp-text-muted, #9ca3af)" }}>
              No deploys or in-flight changes to show.
            </div>
          ) : (
            <ul
              data-testid={`${testId}-list`}
              style={{ listStyle: "none", margin: "0.7rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}
            >
              {pipelines.map((p) => (
                <PipelineRow key={p.id} pipeline={p} testId={`${testId}-row-${p.id}`} />
              ))}
            </ul>
          )}
        </>
      )}
    </GlassPanel>
  );
}

export default DeploymentPipelinePanel;
