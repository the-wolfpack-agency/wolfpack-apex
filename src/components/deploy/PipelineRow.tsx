"use client";

/**
 * PipelineRow — one change's full deployment journey as a header + stepper.
 *
 * Presentational and pure (no fetching): given a DeploymentPipeline, it renders
 * the title/author/overall-status header, a live/migration badge where relevant,
 * the CI -> merge -> build -> promote -> verify -> health Stepper, and a
 * plain-language line for the stage the change is currently at (the "where it is
 * / why it's stuck" read). Reused by both the fleet deployment panel and the
 * per-agent Deployments tab, so the pipeline looks identical everywhere.
 */

import { Stepper, StatusPill } from "@/components/console";
import type { DeploymentPipeline } from "@/lib/deploy/pipeline";

const STATUS_LABEL: Record<DeploymentPipeline["status"], string> = {
  deployed: "Deployed",
  in_progress: "In progress",
  failed: "Failed",
};

export function PipelineRow({
  pipeline,
  testId = "pipeline-row",
}: {
  pipeline: DeploymentPipeline;
  testId?: string;
}) {
  const current = pipeline.stages.find((s) => s.key === pipeline.currentStage);

  return (
    <li
      data-testid={testId}
      data-status={pipeline.status}
      style={{
        listStyle: "none",
        padding: "0.65rem 0.7rem",
        borderRadius: 8,
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
        <StatusPill status={STATUS_LABEL[pipeline.status]} testId={`${testId}-status`} />
        <a
          href={pipeline.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--wp-text, #eee)",
            textDecoration: "none",
            fontSize: "0.86rem",
            fontWeight: 600,
          }}
        >
          {pipeline.prNumber ? `#${pipeline.prNumber} ` : ""}
          {pipeline.title}
        </a>
        {pipeline.live && (
          <span
            data-testid={`${testId}-live`}
            style={{
              fontSize: "0.68rem",
              fontWeight: 700,
              color: "var(--wp-success, #22c55e)",
              border: "1px solid color-mix(in srgb, var(--wp-success, #22c55e) 38%, transparent)",
              borderRadius: 999,
              padding: "1px 7px",
            }}
          >
            LIVE
          </span>
        )}
        {pipeline.hasMigration && (
          <span
            data-testid={`${testId}-migration`}
            title="This change runs a database migration"
            style={{
              fontSize: "0.68rem",
              fontWeight: 700,
              color: "var(--wp-warning, #f97316)",
              border: "1px solid color-mix(in srgb, var(--wp-warning, #f97316) 38%, transparent)",
              borderRadius: 999,
              padding: "1px 7px",
            }}
          >
            MIGRATION
          </span>
        )}
        <span style={{ fontSize: "0.72rem", color: "var(--wp-text-muted, #9ca3af)", flexShrink: 0 }}>
          {pipeline.author}
        </span>
      </div>

      <Stepper
        testId={`${testId}-stepper`}
        steps={pipeline.stages.map((s) => ({
          key: s.key,
          label: s.label,
          status: s.status,
          detail: s.detail,
          url: s.url,
        }))}
      />

      {current && (
        <div
          data-testid={`${testId}-current`}
          style={{ fontSize: "0.76rem", color: "var(--wp-text-dim, #b4bcc8)" }}
        >
          {current.label}: {current.detail}
        </div>
      )}
    </li>
  );
}

export default PipelineRow;
