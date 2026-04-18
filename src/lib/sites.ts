/**
 * Sites library — Instinct's Sites tab.
 *
 * Powers the Max + Meghan workflow: drag a brief into Instinct → get a
 * hosted preview URL on the-wolfpack-agency org. The brief schema mirrors
 * the wolfpack-site-template scaffolder one-to-one so any brief stored
 * here is guaranteed to scaffold there.
 *
 * Closed-loop: every CRUD action emits a tracked event so the brain
 * learns which briefs convert to deploys, which sections get edited most,
 * which deploys fail, and where designers get stuck. NO orphan data.
 */

import { randomUUID } from "node:crypto";
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import {
  createRepoFromTemplate,
  enableActions,
  putFile,
  triggerWorkflow,
  type GithubClient,
  defaultGithubClient,
} from "@/lib/github-client";

/* ----------------------------- Types + validation --------------------- */
// Re-exported from sites-schema.ts so client components can import the
// same types/validator without pulling server-only deps (`pg`, analytics,
// node:crypto) into the browser bundle. Fix for 2026-04-17 Vercel build
// failure: `Module not found: Can't resolve 'tls'` when the preview
// client-component transitively pulled in pg via validateBrief.
export {
  SUPPORTED_SECTION_TYPES,
  BriefValidationError,
  validateBrief,
} from "@/lib/sites-schema";
export type {
  SectionType,
  BriefSection,
  BriefPage,
  SiteBrief,
  SiteStatus,
} from "@/lib/sites-schema";

import { validateBrief } from "@/lib/sites-schema";
import type { SiteBrief, SiteStatus } from "@/lib/sites-schema";

export interface SiteProject {
  id: string;
  client_slug: string;
  display_name: string;
  brief: SiteBrief;
  github_repo: string | null;
  github_repo_url: string | null;
  preview_url: string | null;
  status: SiteStatus;
  last_deploy_id: string | null;
  last_canary_passed: boolean | null;
  agentic_findings: unknown[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

/* ----------------------------- CRUD ----------------------------------- */

function rowToProject(row: Record<string, unknown>): SiteProject {
  return {
    id: row.id as string,
    client_slug: row.client_slug as string,
    display_name: row.display_name as string,
    brief: row.brief as SiteBrief,
    github_repo: (row.github_repo as string) || null,
    github_repo_url: (row.github_repo_url as string) || null,
    preview_url: (row.preview_url as string) || null,
    status: row.status as SiteStatus,
    last_deploy_id: (row.last_deploy_id as string) || null,
    last_canary_passed: (row.last_canary_passed as boolean) ?? null,
    agentic_findings: (row.agentic_findings as unknown[]) || [],
    created_by: row.created_by as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export async function createSiteProject(
  brief: SiteBrief,
  createdBy: string,
  userRole = "unknown",
): Promise<SiteProject> {
  validateBrief(brief);
  const id = `site_${randomUUID()}`;
  const result = await safeQuery<Record<string, unknown>>(
    `INSERT INTO apex_site_projects
       (id, client_slug, display_name, brief, status, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5)
     RETURNING *`,
    [id, brief.client, brief.product.name, JSON.stringify(brief), createdBy],
  );
  const project = rowToProject(result.rows[0]);
  trackEvent("site.created", createdBy, userRole, {
    project_id: id,
    client_slug: brief.client,
    page_count: brief.pages.length,
    section_count: brief.pages.reduce((n, p) => n + p.sections.length, 0),
  });
  return project;
}

export async function listSiteProjects(): Promise<SiteProject[]> {
  const result = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM apex_site_projects
       WHERE status != 'archived'
       ORDER BY updated_at DESC`,
  );
  return result.rows.map(rowToProject);
}

/**
 * Soft-delete a site project. Flips status to 'archived' rather than
 * hard-deleting so audit log, triple-write records, and deployment
 * history remain intact. Returns the archived project (for the caller
 * to confirm + emit audit with before-state).
 */
export async function deleteSiteProject(
  id: string,
  deletedBy: string,
  userRole: string,
): Promise<SiteProject | null> {
  const before = await getSiteProject(id);
  if (!before) return null;
  const result = await safeQuery<Record<string, unknown>>(
    `UPDATE apex_site_projects
       SET status = 'archived', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
    [id],
  );
  const after = result.rows.length > 0 ? rowToProject(result.rows[0]) : before;
  trackEvent("site.archived", deletedBy, userRole, {
    project_id: id,
    client_slug: before.client_slug,
    prior_status: before.status,
  });
  return after;
}

/**
 * Window after which a deploy that never heard back from the canary
 * webhook is assumed dead. GitHub Actions runs can be cancelled by
 * subsequent dispatches or die mid-workflow before the "Notify Instinct"
 * step fires — without this the row sits at `building` forever and the
 * UI spins with no way forward (user on 2026-04-18 had to archive a
 * whole site just to escape the stuck state). 10 min is generous —
 * a healthy canary promotes in ~3 min.
 */
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Reap any deploy rows on *projectId* that have been `pending` or
 * `building` for longer than ``DEPLOY_TIMEOUT_MS``. Marks them failed
 * with a clear log excerpt so the UI knows to surface a retry, and
 * flips the parent project status accordingly. Idempotent.
 */
async function reapStuckDeploys(projectId: string): Promise<void> {
  const cutoffMs = DEPLOY_TIMEOUT_MS;
  const { rows } = await safeQuery<{ id: string }>(
    `UPDATE apex_site_deploys
        SET status = 'failed',
            log_excerpt = COALESCE(log_excerpt, '') ||
              '[reaped] no webhook callback within ' || $2 || ' ms',
            finished_at = NOW()
      WHERE project_id = $1
        AND status IN ('pending','building')
        AND started_at < NOW() - ($2::int * INTERVAL '1 ms')
      RETURNING id`,
    [projectId, cutoffMs],
  );
  if (rows.length > 0) {
    // Flip the project if its status still reflects an in-flight deploy.
    await safeQuery(
      `UPDATE apex_site_projects
          SET status = 'failed', updated_at = NOW()
        WHERE id = $1
          AND status IN ('provisioning','deploying')`,
      [projectId],
    );
  }
}

export async function getSiteProject(id: string): Promise<SiteProject | null> {
  // Cheap, idempotent: any stale in-flight rows get marked failed
  // before we return the project. Keeps the UI honest without a cron.
  await reapStuckDeploys(id).catch(() => {
    // Non-fatal — if the reaper errors we still want to serve the
    // project data so the page loads.
  });
  const result = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM apex_site_projects WHERE id = $1`,
    [id],
  );
  if (result.rows.length === 0) return null;
  return rowToProject(result.rows[0]);
}

export async function updateBrief(
  id: string,
  brief: SiteBrief,
  updatedBy: string,
  userRole = "unknown",
): Promise<SiteProject> {
  validateBrief(brief);
  const result = await safeQuery<Record<string, unknown>>(
    `UPDATE apex_site_projects
        SET brief = $2, display_name = $3, updated_at = NOW()
      WHERE id = $1
  RETURNING *`,
    [id, JSON.stringify(brief), brief.product.name],
  );
  if (result.rows.length === 0) throw new Error("project not found");
  trackEvent("site.brief_updated", updatedBy, userRole, {
    project_id: id,
    client_slug: brief.client,
  });
  return rowToProject(result.rows[0]);
}

export async function recordAssetUpload(
  projectId: string,
  filename: string,
  mimeType: string,
  sizeBytes: number,
  storageUrl: string,
  uploadedBy: string,
  userRole = "unknown",
): Promise<void> {
  const id = `asset_${randomUUID()}`;
  await safeQuery(
    `INSERT INTO apex_site_assets (id, project_id, filename, mime_type, size_bytes, storage_url, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, projectId, filename, mimeType, sizeBytes, storageUrl, uploadedBy],
  );
  trackEvent("site.asset_uploaded", uploadedBy, userRole, {
    project_id: projectId,
    filename,
    size_bytes: sizeBytes,
  });
}

/* ----------------------------- Deploy --------------------------------- */

const TEMPLATE_OWNER = "the-wolfpack-agency";
const TEMPLATE_REPO = "wolfpack-site-template";
const ORG = "the-wolfpack-agency";

/**
 * Provisions a per-client repo from the template, commits the brief, and
 * triggers the canary deploy workflow. Idempotent on the repo creation
 * step (skipped if github_repo is already set on the project).
 *
 * Each phase emits a tracked event so the brain sees the full lifecycle
 * even if a later phase fails. The deploy row is always written so we
 * keep an audit trail of every attempt.
 */
export async function triggerDeploy(
  projectId: string,
  triggeredBy: string,
  userRole = "unknown",
  client: GithubClient = defaultGithubClient(),
): Promise<{ deployId: string; workflowRun: string | null }> {
  const project = await getSiteProject(projectId);
  if (!project) throw new Error("project not found");

  const deployId = `deploy_${randomUUID()}`;
  await safeQuery(
    `INSERT INTO apex_site_deploys (id, project_id, triggered_by, status)
     VALUES ($1, $2, $3, 'pending')`,
    [deployId, projectId, triggeredBy],
  );

  let repoFullName = project.github_repo;
  let repoUrl = project.github_repo_url;

  try {
    if (!repoFullName) {
      const repoName = `wolfpack-${project.client_slug}`;
      const created = await createRepoFromTemplate(
        client,
        TEMPLATE_OWNER,
        TEMPLATE_REPO,
        ORG,
        repoName,
      );
      repoFullName = created.full_name;
      repoUrl = created.html_url;
      // Template-created repos in orgs that default Actions off land in
      // a disabled state — the first workflow dispatch 404s. Explicitly
      // enable Actions so no one has to click the button in the UI.
      // Non-fatal: log and continue if this specific call fails (the
      // dispatch retry loop below will still surface the real failure).
      try {
        await enableActions(client, repoFullName);
      } catch (err) {
        console.warn(
          "[sites] enableActions failed for",
          repoFullName,
          (err as Error).message,
        );
      }
      await safeQuery(
        `UPDATE apex_site_projects
            SET github_repo = $2, github_repo_url = $3, status = 'provisioning', updated_at = NOW()
          WHERE id = $1`,
        [projectId, repoFullName, repoUrl],
      );
      trackEvent("site.repo_provisioned", triggeredBy, userRole, {
        project_id: projectId,
        repo: repoFullName,
      });
    }

    await putFile(
      client,
      repoFullName!,
      `briefs/${project.client_slug}.json`,
      JSON.stringify(project.brief, null, 2),
      `chore: update brief for ${project.client_slug}`,
    );

    const run = await triggerWorkflow(
      client,
      repoFullName!,
      "canary-deploy.yml",
      "main",
      // Pass deployId so the workflow's "Notify Instinct" step actually
      // POSTs back to /api/sites/webhook with preview_url + canary result.
      // Without it, the step skips (empty deploy_id → early exit) and the
      // project sits in `deploying` forever.
      { deploy_id: deployId },
    );

    await safeQuery(
      `UPDATE apex_site_deploys
          SET workflow_run = $2, status = 'building'
        WHERE id = $1`,
      [deployId, run?.run_id ?? null],
    );
    await safeQuery(
      `UPDATE apex_site_projects
          SET status = 'deploying', last_deploy_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [projectId, deployId],
    );

    trackEvent("site.deploy_triggered", triggeredBy, userRole, {
      project_id: projectId,
      deploy_id: deployId,
      repo: repoFullName,
    });

    return { deployId, workflowRun: run?.run_id ?? null };
  } catch (err) {
    await safeQuery(
      `UPDATE apex_site_deploys
          SET status = 'failed', log_excerpt = $2, finished_at = NOW()
        WHERE id = $1`,
      [deployId, (err as Error).message.slice(0, 1000)],
    );
    await safeQuery(
      `UPDATE apex_site_projects SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [projectId],
    );
    trackEvent("site.deploy_failed", triggeredBy, userRole, {
      project_id: projectId,
      deploy_id: deployId,
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Webhook target — called by the GitHub Actions canary workflow when a
 * deploy finishes (success OR failure). Updates project state, stores the
 * preview URL, and emits the right tracked event so analytics never lose
 * a deploy outcome. Idempotent on deployId.
 */
export async function recordDeployResult(
  deployId: string,
  result: {
    status: "success" | "failed";
    previewUrl?: string;
    canaryPassed?: boolean;
    logExcerpt?: string;
    findings?: unknown[];
  },
): Promise<void> {
  const deploy = await safeQuery<{ project_id: string; triggered_by: string }>(
    `UPDATE apex_site_deploys
        SET status = $2, preview_url = $3, canary_passed = $4, log_excerpt = $5, finished_at = NOW()
      WHERE id = $1
  RETURNING project_id, triggered_by`,
    [
      deployId,
      result.status,
      result.previewUrl ?? null,
      result.canaryPassed ?? null,
      (result.logExcerpt ?? "").slice(0, 1000),
    ],
  );
  if (deploy.rows.length === 0) throw new Error(`unknown deploy ${deployId}`);
  const { project_id, triggered_by } = deploy.rows[0];

  const projectStatus: SiteStatus = result.status === "success" ? "ready" : "failed";
  await safeQuery(
    `UPDATE apex_site_projects
        SET status = $2,
            preview_url = COALESCE($3, preview_url),
            last_canary_passed = $4,
            agentic_findings = $5,
            updated_at = NOW()
      WHERE id = $1`,
    [
      project_id,
      projectStatus,
      result.previewUrl ?? null,
      result.canaryPassed ?? null,
      JSON.stringify(result.findings ?? []),
    ],
  );

  if (result.status === "success") {
    trackEvent("site.deploy_succeeded", triggered_by, "system", {
      project_id,
      deploy_id: deployId,
      preview_url: result.previewUrl ?? "",
    });
    if (result.canaryPassed === true) {
      trackEvent("site.canary_passed", triggered_by, "system", { project_id, deploy_id: deployId });
    } else if (result.canaryPassed === false) {
      trackEvent("site.canary_failed", triggered_by, "system", { project_id, deploy_id: deployId });
    }
  } else {
    trackEvent("site.deploy_failed", triggered_by, "system", {
      project_id,
      deploy_id: deployId,
    });
  }
}

export interface SiteDeployRow {
  id: string;
  project_id: string;
  triggered_by: string;
  workflow_run: string | null;
  status: "pending" | "building" | "success" | "failed";
  preview_url: string | null;
  canary_passed: boolean | null;
  log_excerpt: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * List recent deploys for a project, newest first. Used by the admin
 * diagnostic endpoint so operators can see WHY a deploy failed instead
 * of staring at a generic "Internal server error" banner.
 */
export async function listSiteDeploys(
  projectId: string,
  limit = 20,
): Promise<SiteDeployRow[]> {
  const { rows } = await safeQuery<SiteDeployRow>(
    `SELECT id, project_id, triggered_by, workflow_run, status,
            preview_url, canary_passed, log_excerpt,
            started_at, finished_at
       FROM apex_site_deploys
      WHERE project_id = $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [projectId, limit],
  );
  return rows;
}

export async function recordPreviewView(projectId: string, viewerId: string, role: string): Promise<void> {
  trackEvent("site.preview_viewed", viewerId, role, { project_id: projectId });
}

export async function recordLinkShared(projectId: string, sharedBy: string, role: string): Promise<void> {
  trackEvent("site.link_shared", sharedBy, role, { project_id: projectId });
}

// Re-export query for migration runners.
export { query };
