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
  deleteRepo,
  enableActions,
  putFile,
  triggerWorkflow,
  type GithubClient,
  defaultGithubClient,
} from "@/lib/github-client";
import { setRepoSecret } from "@/lib/github-secrets";

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
    `INSERT INTO instinct_site_projects
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
    `SELECT * FROM instinct_site_projects
       WHERE status != 'archived'
       ORDER BY updated_at DESC`,
  );
  return result.rows.map(rowToProject);
}

/** Outcome of the external-resource cleanup phase of a hard delete. */
export interface HardDeleteCleanup {
  githubRepo: { attempted: boolean; ok: boolean; alreadyGone?: boolean; error?: string };
  vercelProject: { attempted: boolean; ok: boolean; alreadyGone?: boolean; error?: string };
}

/**
 * Soft-delete a site project. Flips status to 'archived' rather than
 * hard-deleting so audit log, triple-write records, and deployment
 * history remain intact. Returns the archived project (for the caller
 * to confirm + emit audit with before-state).
 *
 * When ``opts.hard`` is true, also ATTEMPTS to delete the provisioned
 * GitHub repo and linked Vercel project. Each cleanup is independent
 * and defensive: a missing env var, a 404 on the external resource,
 * or an auth failure is logged + recorded + skipped, not thrown. The
 * DB row always flips to archived regardless. Every outcome lands in
 * ``trackEvent`` so the learning loop sees what was cleaned vs
 * skipped vs errored.
 */
export async function deleteSiteProject(
  id: string,
  deletedBy: string,
  userRole: string,
  opts: { hard?: boolean; githubClient?: GithubClient } = {},
): Promise<{ project: SiteProject | null; cleanup: HardDeleteCleanup | null }> {
  const before = await getSiteProject(id);
  if (!before) return { project: null, cleanup: null };

  // On hard delete, free up the client_slug so a future site can reuse
  // the short name. The row stays (audit + triple-write + learning loop
  // all reference it) but the slug gets suffixed with the project id
  // tail so uniqueness never collides. Soft archive leaves the slug
  // intact — reviving a soft-archived site is a future feature.
  const freedSlug =
    opts.hard
      ? `${before.client_slug}--deleted-${id.slice(-8)}`
      : before.client_slug;

  const result = await safeQuery<Record<string, unknown>>(
    `UPDATE instinct_site_projects
       SET status = 'archived', client_slug = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
    [id, freedSlug],
  );
  const after = result.rows.length > 0 ? rowToProject(result.rows[0]) : before;

  let cleanup: HardDeleteCleanup | null = null;
  if (opts.hard) {
    cleanup = await runHardDeleteCleanup({
      project: before,
      deletedBy,
      userRole,
      githubClient: opts.githubClient,
    });
    trackEvent("site.hard_deleted", deletedBy, userRole, {
      project_id: id,
      client_slug: before.client_slug,
      prior_status: before.status,
      github_ok: cleanup.githubRepo.ok,
      github_already_gone: cleanup.githubRepo.alreadyGone ?? false,
      vercel_ok: cleanup.vercelProject.ok,
      vercel_already_gone: cleanup.vercelProject.alreadyGone ?? false,
    });
  } else {
    trackEvent("site.archived", deletedBy, userRole, {
      project_id: id,
      client_slug: before.client_slug,
      prior_status: before.status,
    });
  }
  return { project: after, cleanup };
}

/**
 * Internal: runs the GitHub + Vercel cleanup. Each side is gated on
 * the relevant env var being set; missing creds = skipped, not an
 * error. Emits per-side analytics so ops can filter success vs skip
 * vs error counts in the dashboard.
 */
async function runHardDeleteCleanup(args: {
  project: SiteProject;
  deletedBy: string;
  userRole: string;
  githubClient?: GithubClient;
}): Promise<HardDeleteCleanup> {
  const { project, deletedBy, userRole, githubClient } = args;
  const cleanup: HardDeleteCleanup = {
    githubRepo: { attempted: false, ok: false },
    vercelProject: { attempted: false, ok: false },
  };

  // ── GitHub repo ────────────────────────────────────────────────
  if (project.github_repo) {
    cleanup.githubRepo.attempted = true;
    try {
      const gh = githubClient ?? defaultGithubClient();
      const { alreadyGone } = await deleteRepo(gh, project.github_repo);
      cleanup.githubRepo.ok = true;
      cleanup.githubRepo.alreadyGone = alreadyGone;
      trackEvent(
        alreadyGone ? "site.repo_delete_skipped" : "site.repo_deleted",
        deletedBy,
        userRole,
        {
          project_id: project.id,
          repo: project.github_repo,
          reason: alreadyGone ? "already_gone" : "deleted",
        },
      );
    } catch (err) {
      const message = (err as Error).message;
      cleanup.githubRepo.ok = false;
      cleanup.githubRepo.error = message;
      trackEvent("site.repo_delete_failed", deletedBy, userRole, {
        project_id: project.id,
        repo: project.github_repo,
        error: message.slice(0, 500),
      });
    }
  } else {
    trackEvent("site.repo_delete_skipped", deletedBy, userRole, {
      project_id: project.id,
      reason: "no_repo_provisioned",
    });
  }

  // ── Vercel project ─────────────────────────────────────────────
  cleanup.vercelProject.attempted = true;
  try {
    // Lazy-import so the Vercel module is only loaded when hard-delete
    // runs — keeps cold starts for normal GETs fast.
    const { defaultVercelClient, findProjectByName, deleteProject } = await import(
      "@/lib/vercel-client"
    );
    const client = defaultVercelClient();
    const projectName = `wolfpack-${project.client_slug}`;
    const vp = await findProjectByName(client, projectName);
    if (!vp) {
      cleanup.vercelProject.ok = true;
      cleanup.vercelProject.alreadyGone = true;
      trackEvent("site.vercel_project_delete_skipped", deletedBy, userRole, {
        project_id: project.id,
        vercel_name: projectName,
        reason: "not_found",
      });
    } else {
      const { alreadyGone } = await deleteProject(client, vp.id);
      cleanup.vercelProject.ok = true;
      cleanup.vercelProject.alreadyGone = alreadyGone;
      trackEvent(
        alreadyGone ? "site.vercel_project_delete_skipped" : "site.vercel_project_deleted",
        deletedBy,
        userRole,
        {
          project_id: project.id,
          vercel_id: vp.id,
          vercel_name: projectName,
          reason: alreadyGone ? "already_gone" : "deleted",
        },
      );
    }
  } catch (err) {
    const message = (err as Error).message;
    cleanup.vercelProject.ok = false;
    cleanup.vercelProject.error = message;
    // Missing env var → skipped; anything else → failure. Both still
    // persist to analytics so the learning loop sees why.
    const eventName = /VERCEL_TOKEN|VERCEL_ORG_ID/.test(message)
      ? "site.vercel_project_delete_skipped"
      : "site.vercel_project_delete_failed";
    const meta: Record<string, string | number | boolean> = {
      project_id: project.id,
      error: message.slice(0, 500),
    };
    if (eventName === "site.vercel_project_delete_skipped") {
      meta.reason = "env_not_configured";
    }
    trackEvent(eventName, deletedBy, userRole, meta);
  }

  return cleanup;
}

/**
 * Window after which a deploy that never heard back from the canary
 * webhook is assumed dead. A healthy canary deploy finishes in ~1.5 min;
 * 3 min is a comfortable upper bound that surfaces real failures fast
 * instead of spinning on the UI. The common stuck-deploy case (workflow
 * dies before the "Notify Instinct" step fires) previously left the UI
 * at "Deploying…" for the full 10 min.
 */
const DEPLOY_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Instinct env vars that MUST be set before a deploy can possibly succeed.
 * Missing any of these means the workflow will fail at `vercel pull`
 * before the "Notify Instinct" step runs — leaving the UI stuck at
 * "Deploying…". Fail fast with an actionable message instead.
 */
const REQUIRED_DEPLOY_ENV = [
  "VERCEL_TOKEN_WOLFPACK_AGENCY",
  "VERCEL_ORG_ID",
  "WOLFPACK_SITES_WEBHOOK_SECRET",
] as const;

export function deployEnvPreflight(): { ok: boolean; missing: string[] } {
  const missing = REQUIRED_DEPLOY_ENV.filter((n) => !process.env[n]);
  return { ok: missing.length === 0, missing };
}

/**
 * Reap any deploy rows on *projectId* that have been `pending` or
 * `building` for longer than ``DEPLOY_TIMEOUT_MS``. Marks them failed
 * with a clear log excerpt so the UI knows to surface a retry, and
 * flips the parent project status accordingly. Idempotent.
 */
async function reapStuckDeploys(projectId: string): Promise<void> {
  const cutoffMs = DEPLOY_TIMEOUT_MS;
  const { rows } = await safeQuery<{ id: string }>(
    `UPDATE instinct_site_deploys
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
      `UPDATE instinct_site_projects
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
    `SELECT * FROM instinct_site_projects WHERE id = $1`,
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
    `UPDATE instinct_site_projects
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
    `INSERT INTO instinct_site_assets (id, project_id, filename, mime_type, size_bytes, storage_url, uploaded_by)
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
 * Names of the five GitHub Actions secrets every canary-deploy workflow
 * on a client repo expects. Declared once so test assertions can match the
 * list without re-typing it.
 */
export const CLIENT_REPO_SECRET_NAMES = [
  "VERCEL_TOKEN",
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
  "INSTINCT_WEBHOOK_URL",
  "WOLFPACK_SITES_WEBHOOK_SECRET",
] as const;

/**
 * Auto-provision the five Actions secrets a newly-created client repo
 * needs before its `canary-deploy.yml` workflow can run. Creates a Vercel
 * project named `wolfpack-{client_slug}` first (so VERCEL_PROJECT_ID has a
 * value), then seals + PUTs each secret via `setRepoSecret`.
 *
 * Degrades gracefully at every step:
 *   - Missing env vars → emit `site.vercel_project_create_failed` with
 *     reason `env_not_configured` and return. No secrets are set; the
 *     canary-deploy workflow will fail until a human populates them, but
 *     the deploy row itself isn't blocked.
 *   - Vercel createProject error → emit `site.vercel_project_create_failed`
 *     and skip VERCEL_PROJECT_ID; other four secrets still get set so the
 *     operator only has to paste one value manually.
 *   - Per-secret PUT error → emit `site.repo_secret_failed` and continue.
 *
 * All failures are logged + tracked and NEVER rethrown — the caller's
 * deploy flow stays intact.
 */
export async function provisionClientRepoSecrets(
  client: GithubClient,
  repoFullName: string,
  project: SiteProject,
  triggeredBy: string,
  userRole: string,
): Promise<void> {
  const vercelToken = process.env.VERCEL_TOKEN_WOLFPACK_AGENCY ?? "";
  const vercelOrgId = process.env.VERCEL_ORG_ID ?? "";
  const webhookUrl =
    process.env.INSTINCT_WEBHOOK_URL ||
    "https://wolfpack-instinct.vercel.app/api/sites/webhook";
  const webhookSecret = process.env.WOLFPACK_SITES_WEBHOOK_SECRET ?? "";

  // Env gate: if either shared Vercel credential is missing we can't even
  // create the per-client Vercel project. Emit the dedicated skip event
  // so ops can filter "env not configured" out of true failures.
  if (!vercelToken || !vercelOrgId || !webhookSecret) {
    trackEvent("site.vercel_project_create_failed", triggeredBy, userRole, {
      project_id: project.id,
      repo: repoFullName,
      reason: "env_not_configured",
    });
    return;
  }

  // Step 1: create the Vercel project. Lazy-import matches the hard-delete
  // path in runHardDeleteCleanup so Vercel is only loaded when needed.
  let vercelProjectId: string | null = null;
  try {
    const { defaultVercelClient, createProject } = await import("@/lib/vercel-client");
    const vClient = defaultVercelClient();
    const projectName = `wolfpack-${project.client_slug}`;
    const created = await createProject(vClient, projectName, "nextjs");
    vercelProjectId = created.id;
    trackEvent("site.vercel_project_created", triggeredBy, userRole, {
      project_id: project.id,
      vercel_id: created.id,
      vercel_name: created.name,
    });
  } catch (err) {
    const message = (err as Error).message;
    trackEvent("site.vercel_project_create_failed", triggeredBy, userRole, {
      project_id: project.id,
      repo: repoFullName,
      error: message.slice(0, 200),
    });
    // Fall through: set the other 4 secrets so only VERCEL_PROJECT_ID is
    // missing when the operator checks the repo.
  }

  // Step 2: set each secret. Each failure is logged per-secret so ops can
  // see exactly which one(s) need a manual copy, not just "the whole batch
  // failed". VERCEL_PROJECT_ID is skipped if step 1 didn't yield an id.
  const secretValues: Record<string, string | null> = {
    VERCEL_TOKEN: vercelToken,
    VERCEL_ORG_ID: vercelOrgId,
    VERCEL_PROJECT_ID: vercelProjectId,
    INSTINCT_WEBHOOK_URL: webhookUrl,
    WOLFPACK_SITES_WEBHOOK_SECRET: webhookSecret,
  };

  for (const name of CLIENT_REPO_SECRET_NAMES) {
    const value = secretValues[name];
    if (!value) {
      trackEvent("site.repo_secret_failed", triggeredBy, userRole, {
        project_id: project.id,
        repo: repoFullName,
        secret_name: name,
        error: "value_unavailable",
      });
      continue;
    }
    // Retry 3x with exponential backoff — 2026-04-18 live repro showed
    // a consistent 1-in-5 failure (always the first secret in the loop)
    // likely from repo replication lag right after createRepoFromTemplate.
    // GitHub's public-key endpoint occasionally 404/403s on a brand-new
    // template-fork repo for a few seconds. Retrying closes the gap.
    let lastErr: unknown = null;
    let setOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await setRepoSecret(client, repoFullName, name, value);
        setOk = true;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
    if (setOk) {
      trackEvent("site.repo_secret_set", triggeredBy, userRole, {
        project_id: project.id,
        repo: repoFullName,
        secret_name: name,
      });
    } else {
      const message = (lastErr as Error).message;
      console.warn(
        "[sites] setRepoSecret failed for",
        repoFullName,
        name,
        message,
      );
      trackEvent("site.repo_secret_failed", triggeredBy, userRole, {
        project_id: project.id,
        repo: repoFullName,
        secret_name: name,
        error: message.slice(0, 200),
      });
    }
  }
}

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

  // TODO(wave-I-B+1): client approval gate.
  // Call `checkApprovalGate(projectId)` from `@/lib/site-approvals`
  // here. When it returns { allowed: false }, short-circuit with a
  // typed error that the HTTP route maps to a 409 so the UI can render
  // "Client has not approved this preview yet." Gate is intentionally
  // OFF for this wave — data model + UI shipped first so approvals
  // accumulate before we start blocking deploys on them.

  const deployId = `deploy_${randomUUID()}`;
  await safeQuery(
    `INSERT INTO instinct_site_deploys (id, project_id, triggered_by, status)
     VALUES ($1, $2, $3, 'pending')`,
    [deployId, projectId, triggeredBy],
  );

  // Fail fast if Instinct env is not configured for auto-provisioning.
  // Without these, the dispatched workflow fails at `vercel pull --token=`
  // before the "Notify Instinct" step runs, so no webhook callback ever
  // fires — and the UI stays at "Deploying…" until the reaper expires.
  // Better to mark the deploy failed immediately with an actionable hint.
  const pf = deployEnvPreflight();
  if (!pf.ok) {
    const msg =
      `Deploy aborted: Instinct is missing required env vars (${pf.missing.join(", ")}). ` +
      `Set them in Vercel → Instinct → Settings → Environment Variables, then redeploy.`;
    await safeQuery(
      `UPDATE instinct_site_deploys
          SET status = 'failed', log_excerpt = $2, finished_at = NOW()
        WHERE id = $1`,
      [deployId, msg],
    );
    await safeQuery(
      `UPDATE instinct_site_projects
          SET status = 'failed', updated_at = NOW()
        WHERE id = $1`,
      [projectId],
    );
    trackEvent("site.deploy_failed", triggeredBy, userRole, {
      project_id: projectId,
      deploy_id: deployId,
      reason: "env_not_configured",
      missing: pf.missing.join(","),
      missing_count: pf.missing.length,
    });
    throw new Error(msg);
  }

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
        `UPDATE instinct_site_projects
            SET github_repo = $2, github_repo_url = $3, status = 'provisioning', updated_at = NOW()
          WHERE id = $1`,
        [projectId, repoFullName, repoUrl],
      );
      trackEvent("site.repo_provisioned", triggeredBy, userRole, {
        project_id: projectId,
        repo: repoFullName,
      });
      // Auto-provision the 5 Actions secrets the canary-deploy workflow
      // needs. Every failure is per-secret non-fatal — we log + emit
      // analytics and continue so a misconfigured env never blocks the
      // operator from completing the rest of the deploy (fallback: manual
      // paste in GitHub → Settings → Secrets).
      try {
        await provisionClientRepoSecrets(
          client,
          repoFullName,
          { ...project, github_repo: repoFullName, github_repo_url: repoUrl },
          triggeredBy,
          userRole,
        );
      } catch (err) {
        console.warn(
          "[sites] provisionClientRepoSecrets threw unexpectedly for",
          repoFullName,
          (err as Error).message,
        );
      }
    } else {
      // Self-heal for pre-existing repos created before auto-provisioning
      // shipped (or when Instinct env was previously empty and got filled
      // in later). PUTting an Actions secret is idempotent — GitHub just
      // overwrites. No harm in re-running on every deploy; the cost is
      // five small API calls and it closes the gap that causes stuck
      // "Deploying…" states on older repos.
      try {
        await provisionClientRepoSecrets(
          client,
          repoFullName,
          project,
          triggeredBy,
          userRole,
        );
      } catch (err) {
        console.warn(
          "[sites] self-heal provisionClientRepoSecrets failed for",
          repoFullName,
          (err as Error).message,
        );
      }
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
      `UPDATE instinct_site_deploys
          SET workflow_run = $2, status = 'building'
        WHERE id = $1`,
      [deployId, run?.run_id ?? null],
    );
    await safeQuery(
      `UPDATE instinct_site_projects
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
      `UPDATE instinct_site_deploys
          SET status = 'failed', log_excerpt = $2, finished_at = NOW()
        WHERE id = $1`,
      [deployId, (err as Error).message.slice(0, 1000)],
    );
    await safeQuery(
      `UPDATE instinct_site_projects SET status = 'failed', updated_at = NOW() WHERE id = $1`,
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
    `UPDATE instinct_site_deploys
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
    `UPDATE instinct_site_projects
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
/**
 * Which project a deploy belongs to. The deploy webhook knows only a deploy id,
 * and acceptance is recorded against the project, so this is the one hop
 * between them. Returns null for an unknown deploy rather than throwing: a
 * replayed or stale webhook is a condition to report, not an exception.
 */
export async function getDeployProjectId(deployId: string): Promise<string | null> {
  const { rows } = await safeQuery<{ project_id: string }>(
    `SELECT project_id FROM instinct_site_deploys WHERE id = $1`,
    [deployId],
  );
  return rows[0]?.project_id ?? null;
}

export async function listSiteDeploys(
  projectId: string,
  limit = 20,
): Promise<SiteDeployRow[]> {
  const { rows } = await safeQuery<SiteDeployRow>(
    `SELECT id, project_id, triggered_by, workflow_run, status,
            preview_url, canary_passed, log_excerpt,
            started_at, finished_at
       FROM instinct_site_deploys
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
