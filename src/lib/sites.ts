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
  putFile,
  triggerWorkflow,
  type GithubClient,
  defaultGithubClient,
} from "@/lib/github-client";

/* ----------------------------- Types ---------------------------------- */

export const SUPPORTED_SECTION_TYPES = [
  "hero",
  "text",
  "cards",
  "callout",
  "banner",
  "stats",
  "gallery",
  "quote",
] as const;
export type SectionType = (typeof SUPPORTED_SECTION_TYPES)[number];

export interface BriefSection {
  type: SectionType;
  heading?: string;
  body?: string;
  cta?: { label: string; href: string };
  backgroundImage?: string;
  height?: string;
  items?: Array<{
    title?: string;
    body?: string;
    accent?: boolean;
    badge?: string;
    label?: string;
    value?: number;
    prefix?: string;
    suffix?: string;
  }>;
  images?: Array<{ src: string; alt?: string } | string>;
  attribution?: string;
}

export interface BriefPage {
  route: string;
  title?: string;
  sections: BriefSection[];
}

export interface SiteBrief {
  client: string;
  product: {
    name: string;
    tagline?: string;
    domain?: string;
    supportEmail?: string;
  };
  theme?: Record<string, string>;
  pages: BriefPage[];
  contactForm?: { fields: string[] };
}

export type SiteStatus = "draft" | "provisioning" | "deploying" | "ready" | "failed";

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

/* ----------------------------- Validation ----------------------------- */

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}$/;

export class BriefValidationError extends Error {
  constructor(public errors: string[]) {
    super(`brief invalid:\n  - ${errors.join("\n  - ")}`);
    this.name = "BriefValidationError";
  }
}

/**
 * Strict server-side brief validation. Mirrors the wolfpack-site-template
 * scaffolder validator one-to-one so anything we accept is guaranteed to
 * render there. Throws BriefValidationError on any failure.
 */
export function validateBrief(brief: unknown): asserts brief is SiteBrief {
  const errors: string[] = [];
  const b = brief as Partial<SiteBrief> | null;

  if (!b || typeof b !== "object") {
    throw new BriefValidationError(["brief must be an object"]);
  }
  if (!b.client || typeof b.client !== "string" || !SLUG_RE.test(b.client)) {
    errors.push("client must be a lowercase slug (a-z, 0-9, -; 2-39 chars)");
  }
  if (!b.product?.name || typeof b.product.name !== "string") {
    errors.push("product.name required");
  }
  if (b.product?.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.product.supportEmail)) {
    errors.push("product.supportEmail must be a valid email");
  }
  if (!Array.isArray(b.pages) || b.pages.length === 0) {
    errors.push("pages array required (at least one page)");
  }
  const known = new Set<string>(SUPPORTED_SECTION_TYPES);
  for (const p of b.pages || []) {
    if (!p.route?.startsWith("/")) errors.push(`page.route must start with / (got ${p.route})`);
    if (!Array.isArray(p.sections)) {
      errors.push(`page ${p.route}: sections array required`);
      continue;
    }
    for (const s of p.sections) {
      if (!known.has(s.type)) {
        errors.push(`page ${p.route}: unknown section type "${s.type}"`);
      }
      if (s.type === "stats") {
        for (const it of s.items || []) {
          if (typeof it.value !== "number") {
            errors.push(`page ${p.route}: stats.items[].value must be a number`);
          }
        }
      }
      if (s.type === "gallery" && !Array.isArray(s.images)) {
        errors.push(`page ${p.route}: gallery.images array required`);
      }
    }
  }
  if (errors.length > 0) throw new BriefValidationError(errors);
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
    `SELECT * FROM apex_site_projects ORDER BY updated_at DESC`,
  );
  return result.rows.map(rowToProject);
}

export async function getSiteProject(id: string): Promise<SiteProject | null> {
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

export async function recordPreviewView(projectId: string, viewerId: string, role: string): Promise<void> {
  trackEvent("site.preview_viewed", viewerId, role, { project_id: projectId });
}

export async function recordLinkShared(projectId: string, sharedBy: string, role: string): Promise<void> {
  trackEvent("site.link_shared", sharedBy, role, { project_id: projectId });
}

// Re-export query for migration runners.
export { query };
