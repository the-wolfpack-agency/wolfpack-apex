/**
 * Deployment pipeline model: stitch the tools a code change passes through on
 * its way to production into ONE ordered, staged object per change.
 *
 * The release gate (release-gate.ts) models only the pre-merge slice (what is
 * blocking the next deploy). This composes the WHOLE journey by joining data we
 * can already read:
 *   - GitHub (via the release gate): CI checks + merge state for in-flight PRs.
 *   - Vercel (src/lib/integrations/vercel.ts): build + promote state for merged
 *     changes, joined to the commit SHA.
 *   - Instinct's own post-deploy checks: the serving-commit SHA
 *     (process.env.VERCEL_GIT_COMMIT_SHA, same as GET /api/version) and the
 *     deployment-readiness probe (deployment-readiness.ts) for prod health.
 *
 * buildPipeline is pure and deterministic (unit-testable with no I/O). The
 * orchestrators fetch from the readers above and honest-degrade per source: if
 * Vercel is not configured, the build/deploy stages are reported as an explicit
 * degrade, never a false all-clear. Nothing here mutates anything; promotion is
 * the release gate's existing one-click action.
 */

import {
  getReleaseGate,
  type ReleaseGateStatus,
  type ReleaseBlockState,
} from "./release-gate";
import {
  listDeployments,
  vercelIsConfigured,
  deploymentDashboardUrl,
  type VercelDeployment,
  type VercelResult,
} from "@/lib/integrations/vercel";
import {
  runDeploymentReadiness,
  type ReadinessResult,
} from "./deployment-readiness";
import { safeQuery } from "@/lib/db";

/** The Vercel project whose production deployments back this app. */
const PROJECT_NAME = process.env.VERCEL_PROJECT_NAME ?? "wolfpack-instinct";

/** The fixed, ordered stages every change passes through. */
export type PipelineStageKey =
  | "ci"
  | "merge"
  | "build"
  | "promote"
  | "verify"
  | "health";

export const STAGE_ORDER: PipelineStageKey[] = [
  "ci",
  "merge",
  "build",
  "promote",
  "verify",
  "health",
];

export const STAGE_LABEL: Record<PipelineStageKey, string> = {
  ci: "CI checks",
  merge: "Merge",
  build: "Build + migrate",
  promote: "Promote",
  verify: "Prod verify",
  health: "Health",
};

export type PipelineStageStatus =
  | "passed"
  | "running"
  | "failed"
  | "pending"
  | "skipped";

export interface PipelineStage {
  key: PipelineStageKey;
  label: string;
  status: PipelineStageStatus;
  /** Operator-facing, plain-language, never a raw provider enum. */
  detail: string;
  /** Optional click-through (the Vercel inspector, the PR, etc.). */
  url?: string;
}

export type PipelineStatus = "deployed" | "in_progress" | "failed";

export interface DeploymentPipeline {
  /** Stable key: the commit SHA when known, else a PR key. */
  id: string;
  title: string;
  url: string;
  author: string;
  commitSha: string | null;
  prNumber: number | null;
  ageHours: number | null;
  hasMigration: boolean;
  stages: PipelineStage[];
  status: PipelineStatus;
  /** The stage the change is currently at (drives the "stuck here" read). */
  currentStage: PipelineStageKey;
  /** True when this deploy's commit is the one production is serving now. */
  live: boolean;
}

/** Normalized input to the pure builder. Exactly one of gateState / deploy is set. */
export interface PipelineChangeInput {
  id: string;
  title: string;
  url: string;
  author: string;
  commitSha: string | null;
  prNumber: number | null;
  ageHours?: number | null;
  hasMigration?: boolean;
  /** In-flight (pre-merge) signal from the release gate. */
  gateState?: ReleaseBlockState | null;
  /** Post-merge signal from Vercel. */
  deploy?: {
    state: VercelDeployment["state"];
    target: VercelDeployment["target"];
    /** This deploy's commit == the currently-serving commit. */
    isLive: boolean;
    /** Prod health, only computed for the live deploy (else null). */
    health: "healthy" | "unhealthy" | null;
    inspectorUrl?: string;
  } | null;
}

function deriveOverall(stages: PipelineStage[]): {
  status: PipelineStatus;
  currentStage: PipelineStageKey;
} {
  const failed = stages.find((s) => s.status === "failed");
  if (failed) return { status: "failed", currentStage: failed.key };
  const running = stages.find((s) => s.status === "running");
  if (running) return { status: "in_progress", currentStage: running.key };
  const pending = stages.find((s) => s.status === "pending");
  if (pending) return { status: "in_progress", currentStage: pending.key };
  // No failure, nothing running, nothing pending: fully resolved.
  return { status: "deployed", currentStage: stages[stages.length - 1].key };
}

/**
 * Compose the six ordered stages for one change. Pure: same input, same output,
 * no I/O, no clock. The two branches mirror where a change can be:
 *   - deploy set  -> merged, being built / promoted / verified on Vercel.
 *   - gateState   -> still an open PR; downstream stages have not happened yet.
 */
export function buildPipeline(input: PipelineChangeInput): DeploymentPipeline {
  const stages: PipelineStage[] = [];
  const add = (
    key: PipelineStageKey,
    status: PipelineStageStatus,
    detail: string,
    url?: string,
  ) => stages.push({ key, label: STAGE_LABEL[key], status, detail, url });

  const migrationNote = input.hasMigration ? " (includes a DB migration)" : "";

  if (input.deploy) {
    const { state, target, isLive, health, inspectorUrl } = input.deploy;
    add("ci", "passed", "Checks passed before merge");
    add("merge", "passed", "Merged to the production branch");

    if (state === "ERROR") {
      add(
        "build",
        "failed",
        input.hasMigration ? "Build or migration failed" : "Build failed",
        inspectorUrl,
      );
    } else if (state === "CANCELED") {
      add("build", "skipped", "Build canceled", inspectorUrl);
    } else if (state === "READY") {
      add("build", "passed", `Built${migrationNote}`, inspectorUrl);
    } else {
      add("build", "running", `Building${migrationNote}`, inspectorUrl);
    }

    if (state === "READY" && target === "production") {
      add("promote", "passed", "Promoted to production");
    } else if (state === "ERROR" || state === "CANCELED") {
      add("promote", "skipped", "Not promoted");
    } else {
      add("promote", "pending", "Awaiting a successful build");
    }

    if (state !== "READY") {
      add("verify", "pending", "Awaiting promotion");
    } else if (isLive) {
      add("verify", "passed", "Live: the production alias serves this commit");
    } else {
      add("verify", "skipped", "Superseded by a newer deploy");
    }

    if (!isLive) {
      add("health", "skipped", "Only the live deploy is health-checked");
    } else if (health === "healthy") {
      add("health", "passed", "Production health checks pass");
    } else if (health === "unhealthy") {
      add("health", "failed", "A critical production health check failed");
    } else {
      add("health", "pending", "Health check pending");
    }
  } else {
    const g = input.gateState ?? "checks_running";
    if (g === "checks_failing") add("ci", "failed", "A required check is failing");
    else if (g === "checks_running") add("ci", "running", "Checks are running");
    else add("ci", "passed", "Checks passed");

    if (g === "merge_conflict") {
      add("merge", "failed", "Merge conflict with the production branch");
    } else if (g === "ready_to_merge") {
      add("merge", "running", "Ready to promote");
    } else if (g === "awaiting_approval") {
      add("merge", "pending", "Awaiting approval");
    } else {
      add("merge", "pending", "Awaiting a clean CI and approval");
    }

    add("build", "pending", `Not merged yet${migrationNote}`);
    add("promote", "pending", "Not merged yet");
    add("verify", "pending", "Not merged yet");
    add("health", "pending", "Not merged yet");
  }

  const overall = deriveOverall(stages);
  return {
    id: input.id,
    title: input.title,
    url: input.url,
    author: input.author,
    commitSha: input.commitSha,
    prNumber: input.prNumber,
    ageHours: input.ageHours ?? null,
    hasMigration: Boolean(input.hasMigration),
    stages,
    status: overall.status,
    currentStage: overall.currentStage,
    live: Boolean(input.deploy?.isLive),
  };
}

/** Injectable readers so the orchestrator is unit-testable with fakes. */
export interface PipelineDeps {
  releaseGate: () => Promise<ReleaseGateStatus>;
  listDeployments: (
    project: string,
    limit: number,
  ) => Promise<VercelResult<{ deployments: VercelDeployment[] }>>;
  vercelConfigured: () => boolean;
  readiness: () => Promise<ReadinessResult>;
  servingSha: () => string | null;
}

export function defaultPipelineDeps(): PipelineDeps {
  return {
    releaseGate: () => getReleaseGate(),
    listDeployments: (project, limit) =>
      listDeployments({ projectName: project, limit }),
    vercelConfigured: vercelIsConfigured,
    readiness: () => runDeploymentReadiness(),
    servingSha: () => process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  };
}

export interface DeploymentPipelineReport {
  pipelines: DeploymentPipeline[];
  servingSha: string | null;
  checkedAt: string;
  /** Per-source honest-degrade. A degrade is NEVER a false all-clear. */
  degraded: Array<{ source: "github" | "vercel"; detail: string }>;
}

/**
 * The fleet-wide pipeline report: recent production deploys (from Vercel) plus
 * the in-flight PRs the release gate says are still blocking (deduped against
 * anything already deployed). Honest-degrade per source. Never throws.
 */
export async function getDeploymentPipelines(
  opts: { limit?: number; deps?: PipelineDeps } = {},
): Promise<DeploymentPipelineReport> {
  const deps = opts.deps ?? defaultPipelineDeps();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30);
  const degraded: DeploymentPipelineReport["degraded"] = [];
  const servingSha = deps.servingSha();

  // Prod health is one fleet-level signal, attributed to the live deploy only.
  let health: "healthy" | "unhealthy" | null = null;
  try {
    const r = await deps.readiness();
    health = r.ok ? "healthy" : "unhealthy";
  } catch {
    health = null;
  }

  const pipelines: DeploymentPipeline[] = [];
  const deployedShas = new Set<string>();

  if (deps.vercelConfigured()) {
    const res = await deps.listDeployments(PROJECT_NAME, limit).catch(
      (e: unknown) => ({ ok: false, error: (e as Error).message }) as VercelResult<{
        deployments: VercelDeployment[];
      }>,
    );
    if (res.ok && res.data) {
      for (const d of res.data.deployments) {
        if (d.target !== "production") continue;
        const sha = d.meta?.githubCommitSha ?? null;
        if (sha) deployedShas.add(sha);
        const isLive = Boolean(sha && servingSha && sha === servingSha);
        pipelines.push(
          buildPipeline({
            id: sha ?? d.uid,
            title: d.meta?.githubCommitMessage?.split("\n")[0] || d.name,
            url: deploymentDashboardUrl(d),
            author: d.creator?.username ?? "unknown",
            commitSha: sha,
            prNumber: null,
            deploy: {
              state: d.state,
              target: d.target,
              isLive,
              health: isLive ? health : null,
              inspectorUrl: d.inspectorUrl,
            },
          }),
        );
      }
    } else {
      degraded.push({ source: "vercel", detail: res.error ?? "Vercel API error" });
    }
  } else {
    degraded.push({
      source: "vercel",
      detail: "Set VERCEL_API_TOKEN to see build and deploy stages.",
    });
  }

  const gate = await deps.releaseGate().catch(() => null);
  if (!gate) {
    degraded.push({ source: "github", detail: "Could not reach GitHub." });
  } else if (gate.degraded) {
    degraded.push({ source: "github", detail: gate.degraded.detail });
  } else {
    for (const c of gate.blocking) {
      if (deployedShas.has(c.headSha)) continue;
      pipelines.push(
        buildPipeline({
          id: `pr-${c.number}`,
          title: c.title,
          url: c.url,
          author: c.author,
          commitSha: c.headSha,
          prNumber: c.number,
          ageHours: c.ageHours,
          gateState: c.state,
        }),
      );
    }
  }

  return {
    pipelines,
    servingSha,
    checkedAt: new Date().toISOString(),
    degraded,
  };
}

export interface AgentDeploymentLink {
  prNumber: number;
  /** The gate state at the moment the agent was dispatched to triage it. */
  stateAtTriage: string | null;
  triagedAt: string;
  /** The live pipeline for this PR if it is still in flight; null once resolved. */
  pipeline: DeploymentPipeline | null;
  /** True when the PR is no longer blocking (merged or closed since triage). */
  resolved: boolean;
}

export interface AgentDeploymentReport {
  links: AgentDeploymentLink[];
  degraded: DeploymentPipelineReport["degraded"];
  checkedAt: string;
}

/**
 * The deployments an agent engaged with, via the deploy_gate triage dispatches
 * it received (the #150 wiring). Reads the structured deploy.triage_dispatched
 * analytics events (agent_id + pr_number), then matches each PR to its current
 * fleet pipeline. A PR that is no longer in flight is reported as resolved
 * (merged/closed since triage) rather than dropped. Never throws.
 */
export async function getAgentDeploymentPipelines(
  agentId: string,
  _workspaceId: string,
  deps?: PipelineDeps,
): Promise<AgentDeploymentReport> {
  let triaged: Array<{ pr: number; state: string | null; at: string }> = [];
  try {
    const res = await safeQuery<{ pr: string; state: string | null; at: string }>(
      `SELECT metadata->>'pr_number' AS pr,
              metadata->>'state'     AS state,
              MAX(timestamp)::text   AS at
         FROM instinct_events
        WHERE event_type = 'deploy.triage_dispatched'
          AND metadata->>'agent_id' = $1
          AND metadata->>'pr_number' IS NOT NULL
        GROUP BY metadata->>'pr_number', metadata->>'state'
        ORDER BY MAX(timestamp) DESC
        LIMIT 50`,
      [agentId],
    );
    // Dedupe by PR, keeping the most recent triage.
    const seen = new Set<number>();
    for (const r of res.rows) {
      const pr = Number(r.pr);
      if (!Number.isFinite(pr) || seen.has(pr)) continue;
      seen.add(pr);
      triaged.push({ pr, state: r.state, at: String(r.at) });
    }
  } catch {
    triaged = [];
  }

  if (triaged.length === 0) {
    return { links: [], degraded: [], checkedAt: new Date().toISOString() };
  }

  const report = await getDeploymentPipelines({ deps });
  const byPr = new Map<number, DeploymentPipeline>();
  for (const p of report.pipelines) {
    if (p.prNumber != null) byPr.set(p.prNumber, p);
  }

  const links: AgentDeploymentLink[] = triaged.map((t) => {
    const pipeline = byPr.get(t.pr) ?? null;
    return {
      prNumber: t.pr,
      stateAtTriage: t.state,
      triagedAt: t.at,
      pipeline,
      resolved: pipeline === null,
    };
  });

  return { links, degraded: report.degraded, checkedAt: report.checkedAt };
}
