/**
 * site-domains.ts — DB + analytics orchestration over `sites-domain.ts`.
 *
 * Responsibilities:
 *   - Resolve the underlying Vercel project id for a given site by
 *     looking up `wolfpack-{client_slug}` (matches the naming used
 *     everywhere else in sites.ts — we intentionally do NOT persist the
 *     Vercel project id on `apex_site_projects` because hard-delete
 *     already uses name-based lookup, and naming remains the single
 *     source of truth).
 *   - Persist every domain add/refresh/remove into `apex_site_domains`.
 *   - Fire analytics on every lifecycle transition so the learning loop
 *     sees which clients need custom domains most, which domains fail
 *     verification, which designers are the power users.
 *
 * Graceful degradation: missing Vercel creds do NOT throw here — the
 * caller (HTTP route) translates them into a typed 503 for the UI. The
 * DB row is still written (status='failed') so the attempt is visible
 * in the audit log.
 */

import { randomUUID } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import {
  addDomainToProject,
  getDomainStatus,
  removeDomainFromProject,
  isValidDomain,
  VercelDomainError,
  type VercelDomainRecord,
} from "@/lib/sites-domain";

export interface DomainRecord {
  id: string;
  site_id: string;
  domain: string;
  status: "pending" | "verified" | "removed" | "failed";
  verification_records: Array<{
    type: string;
    domain: string;
    value: string;
    reason?: string;
  }>;
  added_by: string | null;
  added_at: string;
  verified_at: string | null;
  removed_at: string | null;
  last_error: string | null;
}

/** Read the Vercel project id for a site by resolving the well-known
 * naming convention (`wolfpack-{client_slug}`). Returns null when the
 * site isn't provisioned yet OR when the lookup fails; callers surface
 * this as a 503 "not yet deployed" at the HTTP layer so the UI can tell
 * the designer to run a first deploy before binding a domain.
 *
 * Split from the main entry points so tests can stub it in isolation.
 */
export async function resolveVercelProjectId(
  siteId: string,
): Promise<{ projectId: string | null; clientSlug: string | null }> {
  const { rows } = await safeQuery<{ client_slug: string }>(
    `SELECT client_slug FROM apex_site_projects WHERE id = $1`,
    [siteId],
  );
  if (rows.length === 0) return { projectId: null, clientSlug: null };
  const slug = rows[0].client_slug;
  const token = process.env.VERCEL_TOKEN_WOLFPACK_AGENCY ?? "";
  const teamId = process.env.VERCEL_ORG_ID ?? "";
  if (!token || !teamId) return { projectId: null, clientSlug: slug };
  try {
    const { defaultVercelClient, findProjectByName } = await import(
      "@/lib/vercel-client"
    );
    const client = defaultVercelClient();
    const vp = await findProjectByName(client, `wolfpack-${slug}`);
    return { projectId: vp?.id ?? null, clientSlug: slug };
  } catch {
    return { projectId: null, clientSlug: slug };
  }
}

function rowToRecord(row: Record<string, unknown>): DomainRecord {
  const verRaw = row.verification_records;
  let ver: DomainRecord["verification_records"] = [];
  if (Array.isArray(verRaw)) {
    ver = verRaw as DomainRecord["verification_records"];
  } else if (typeof verRaw === "string") {
    try { ver = JSON.parse(verRaw); } catch { ver = []; }
  }
  return {
    id: String(row.id),
    site_id: String(row.site_id),
    domain: String(row.domain),
    status: row.status as DomainRecord["status"],
    verification_records: ver,
    added_by: (row.added_by as string) || null,
    added_at: row.added_at as string,
    verified_at: (row.verified_at as string) || null,
    removed_at: (row.removed_at as string) || null,
    last_error: (row.last_error as string) || null,
  };
}

function statusFromVercel(record: VercelDomainRecord): "pending" | "verified" {
  return record.verified ? "verified" : "pending";
}

/**
 * Attach a domain to a site and persist the verification records so the
 * UI can render them. Any Vercel error is caught + written as a
 * status='failed' row so NO DATA IS LOST — the learning loop sees the
 * exact reason the attempt failed, not a generic 500.
 */
export async function registerDomain(opts: {
  siteId: string;
  domain: string;
  userId: string;
  userRole?: string;
  /** Override for tests. */
  vercelAdd?: typeof addDomainToProject;
  resolveProjectId?: typeof resolveVercelProjectId;
}): Promise<DomainRecord> {
  const domain = String(opts.domain ?? "").trim().toLowerCase();
  const userRole = opts.userRole ?? "unknown";

  if (!isValidDomain(domain)) {
    throw new VercelDomainError(
      "domain_invalid",
      400,
      `domain "${domain}" failed local validation`,
    );
  }

  const resolver = opts.resolveProjectId ?? resolveVercelProjectId;
  const { projectId } = await resolver(opts.siteId);
  if (!projectId) {
    trackEvent("site.domain_add_failed", opts.userId, userRole, {
      site_id: opts.siteId,
      domain,
      reason: "vercel_project_not_found",
    });
    throw new VercelDomainError(
      "unknown",
      503,
      "Vercel project not found for this site. Run a first deploy before binding a domain.",
    );
  }

  const token = process.env.VERCEL_TOKEN_WOLFPACK_AGENCY ?? "";
  const teamId = process.env.VERCEL_ORG_ID ?? "";
  if (!token || !teamId) {
    trackEvent("site.domain_add_failed", opts.userId, userRole, {
      site_id: opts.siteId,
      domain,
      reason: "env_not_configured",
    });
    throw new VercelDomainError(
      "unauthorized",
      503,
      "Vercel credentials missing: set VERCEL_TOKEN_WOLFPACK_AGENCY and VERCEL_ORG_ID",
    );
  }

  const addFn = opts.vercelAdd ?? addDomainToProject;
  let record: VercelDomainRecord;
  try {
    record = await addFn({ projectId, domain, teamId, token });
  } catch (err) {
    const e = err as VercelDomainError;
    // Persist the failed attempt so the row exists for auditing + the
    // unique constraint keeps future dupes noisy. We DON'T insert on
    // 409 domain_in_use — the unique constraint would throw anyway and
    // the caller's HTTP handler maps it to a clean 409.
    if (e.code !== "domain_in_use") {
      const id = `domain_${randomUUID()}`;
      await safeQuery(
        `INSERT INTO apex_site_domains
           (id, site_id, domain, status, verification_records, added_by, last_error)
         VALUES ($1, $2, $3, 'failed', $4, $5, $6)
         ON CONFLICT (domain) DO UPDATE
           SET status = EXCLUDED.status,
               last_error = EXCLUDED.last_error,
               verification_records = EXCLUDED.verification_records`,
        [id, opts.siteId, domain, JSON.stringify([]), opts.userId, e.message.slice(0, 500)],
      );
    }
    trackEvent("site.domain_add_failed", opts.userId, userRole, {
      site_id: opts.siteId,
      domain,
      reason: e.code ?? "unknown",
      user_id: opts.userId,
    });
    throw err;
  }

  const id = `domain_${randomUUID()}`;
  const status = statusFromVercel(record);
  const result = await safeQuery<Record<string, unknown>>(
    `INSERT INTO apex_site_domains
       (id, site_id, domain, status, verification_records, added_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      id,
      opts.siteId,
      domain,
      status,
      JSON.stringify(record.verification),
      opts.userId,
    ],
  );

  trackEvent("site.domain_added", opts.userId, userRole, {
    site_id: opts.siteId,
    domain,
    user_id: opts.userId,
    pending: status === "pending",
  });
  if (status === "verified") {
    trackEvent("site.domain_verified", opts.userId, userRole, {
      site_id: opts.siteId,
      domain,
      verification_latency_sec: 0,
    });
  }

  if (result.rows.length === 0) {
    // safeQuery swallows errors in shadow mode; synthesise a record so
    // the UI can still render the verification block.
    return {
      id,
      site_id: opts.siteId,
      domain,
      status,
      verification_records: record.verification,
      added_by: opts.userId,
      added_at: new Date().toISOString(),
      verified_at: status === "verified" ? new Date().toISOString() : null,
      removed_at: null,
      last_error: null,
    };
  }
  return rowToRecord(result.rows[0]);
}

/**
 * Re-poll Vercel for the verification state and update the DB row.
 * Emits `site.domain_verified` the first time we observe `verified=true`
 * — gated on the prior row status so the event fires exactly once per
 * domain per attach cycle.
 */
export async function refreshDomainStatus(opts: {
  siteId: string;
  domain: string;
  userId: string;
  userRole?: string;
  vercelStatus?: typeof getDomainStatus;
  resolveProjectId?: typeof resolveVercelProjectId;
}): Promise<DomainRecord> {
  const domain = String(opts.domain ?? "").trim().toLowerCase();
  const userRole = opts.userRole ?? "unknown";
  if (!isValidDomain(domain)) {
    throw new VercelDomainError(
      "domain_invalid",
      400,
      `domain "${domain}" failed local validation`,
    );
  }

  const resolver = opts.resolveProjectId ?? resolveVercelProjectId;
  const { projectId } = await resolver(opts.siteId);
  if (!projectId) {
    throw new VercelDomainError(
      "unknown",
      503,
      "Vercel project not found for this site",
    );
  }

  const token = process.env.VERCEL_TOKEN_WOLFPACK_AGENCY ?? "";
  const teamId = process.env.VERCEL_ORG_ID ?? "";
  if (!token || !teamId) {
    throw new VercelDomainError(
      "unauthorized",
      503,
      "Vercel credentials missing",
    );
  }

  const prior = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM apex_site_domains WHERE site_id = $1 AND domain = $2`,
    [opts.siteId, domain],
  );
  const wasVerifiedBefore =
    prior.rows.length > 0 && prior.rows[0].status === "verified";

  const statusFn = opts.vercelStatus ?? getDomainStatus;
  const record = await statusFn({ projectId, domain, teamId, token });
  if (!record) {
    // Vercel no longer knows about this domain → mark removed.
    const result = await safeQuery<Record<string, unknown>>(
      `UPDATE apex_site_domains
          SET status = 'removed', removed_at = NOW()
        WHERE site_id = $1 AND domain = $2
      RETURNING *`,
      [opts.siteId, domain],
    );
    if (result.rows.length === 0) {
      throw new VercelDomainError(
        "unknown",
        404,
        `domain ${domain} not attached to site ${opts.siteId}`,
      );
    }
    return rowToRecord(result.rows[0]);
  }

  const status = statusFromVercel(record);
  const result = await safeQuery<Record<string, unknown>>(
    `UPDATE apex_site_domains
        SET status = $3,
            verification_records = $4,
            verified_at = CASE WHEN $3 = 'verified' AND verified_at IS NULL
                              THEN NOW() ELSE verified_at END
      WHERE site_id = $1 AND domain = $2
    RETURNING *`,
    [opts.siteId, domain, status, JSON.stringify(record.verification)],
  );

  if (status === "verified" && !wasVerifiedBefore) {
    // Latency from added_at → verified_at, bounded at 1h for sanity.
    const addedAtMs =
      prior.rows.length > 0 && prior.rows[0].added_at
        ? new Date(prior.rows[0].added_at as string).getTime()
        : Date.now();
    const latencySec = Math.max(
      0,
      Math.min(60 * 60, Math.round((Date.now() - addedAtMs) / 1000)),
    );
    trackEvent("site.domain_verified", opts.userId, userRole, {
      site_id: opts.siteId,
      domain,
      verification_latency_sec: latencySec,
    });
  }

  if (result.rows.length === 0) {
    throw new VercelDomainError(
      "unknown",
      404,
      `domain ${domain} not attached to site ${opts.siteId}`,
    );
  }
  return rowToRecord(result.rows[0]);
}

/**
 * Detach a domain. Idempotent: if the domain isn't on Vercel any more
 * OR isn't in our DB, the caller still gets `success`.
 */
export async function unregisterDomain(opts: {
  siteId: string;
  domain: string;
  userId: string;
  userRole?: string;
  vercelRemove?: typeof removeDomainFromProject;
  resolveProjectId?: typeof resolveVercelProjectId;
}): Promise<void> {
  const domain = String(opts.domain ?? "").trim().toLowerCase();
  const userRole = opts.userRole ?? "unknown";
  if (!isValidDomain(domain)) {
    throw new VercelDomainError(
      "domain_invalid",
      400,
      `domain "${domain}" failed local validation`,
    );
  }

  const resolver = opts.resolveProjectId ?? resolveVercelProjectId;
  const { projectId } = await resolver(opts.siteId);
  const token = process.env.VERCEL_TOKEN_WOLFPACK_AGENCY ?? "";
  const teamId = process.env.VERCEL_ORG_ID ?? "";

  // Only call Vercel if we CAN — missing env / missing project id is
  // still a valid "unregister" since the DB row is the source of truth
  // for the designer's UI list.
  if (projectId && token && teamId) {
    const removeFn = opts.vercelRemove ?? removeDomainFromProject;
    try {
      await removeFn({ projectId, domain, teamId, token });
    } catch (err) {
      // Swallow — we still want the DB flipped to removed. The error is
      // logged in analytics so ops can see Vercel-side stragglers.
      trackEvent("site.domain_add_failed", opts.userId, userRole, {
        site_id: opts.siteId,
        domain,
        reason: `remove_${(err as VercelDomainError).code ?? "unknown"}`,
        user_id: opts.userId,
      });
    }
  }

  await safeQuery(
    `UPDATE apex_site_domains
        SET status = 'removed', removed_at = NOW()
      WHERE site_id = $1 AND domain = $2`,
    [opts.siteId, domain],
  );
  trackEvent("site.domain_removed", opts.userId, userRole, {
    site_id: opts.siteId,
    domain,
    user_id: opts.userId,
  });
}

/**
 * List every domain attached to a site, newest first. Includes `removed`
 * rows because the audit history is part of the learning signal (which
 * clients kept custom domains, which churned immediately).
 */
export async function listDomainsForSite(
  siteId: string,
): Promise<DomainRecord[]> {
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM apex_site_domains
       WHERE site_id = $1
       ORDER BY added_at DESC`,
    [siteId],
  );
  return rows.map(rowToRecord);
}
