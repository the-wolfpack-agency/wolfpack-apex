/**
 * Thin Vercel REST wrapper for the Sites "hard delete" path.
 *
 * Two operations only:
 *   1. findProjectByName — resolve a project by name (for delete/idempotency checks)
 *   2. deleteProject     — tear down a Vercel project permanently (idempotent)
 *
 * Mirrors the shape of `github-client.ts`: injectable `fetch`, token injected
 * at construction, no new runtime dependencies. `defaultVercelClient()` reads
 * VERCEL_TOKEN_WOLFPACK_AGENCY (org-scoped PAT) and VERCEL_ORG_ID from env
 * and throws a typed error naming BOTH variables if either is missing, so
 * callers (sites.ts) can degrade gracefully — the archive path continues to
 * work even when Vercel creds aren't set locally in dev.
 *
 * SECURITY NOTE: this module is server-only. Importing from a client
 * component will leak the token into the browser bundle. The auth gate on
 * /api/sites/* must be checked before any function here is called.
 *
 * Analytics: this module does NOT emit analytics events directly — the
 * orchestration layer in sites.ts owns those, and it emits one event per
 * lifecycle action (site.deleted) wrapping the Vercel + GitHub + DB tuple.
 * Keeping emission there preserves a single source of truth for the
 * analytics/learning pipeline and avoids double-counting.
 */

export interface VercelClient {
  token: string;
  teamId: string;
  fetch: typeof fetch;
}

export interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  gitRepository?: { repo: string; type: string } | null;
}

export class VercelApiError extends Error {
  public status: number;
  public body: string;
  constructor(status: number, body: string) {
    super(`vercel ${status}: ${body.slice(0, 300)}`);
    this.name = "VercelApiError";
    this.status = status;
    this.body = body;
  }
}

const VERCEL_API = "https://api.vercel.com";

/**
 * Read VERCEL_TOKEN_WOLFPACK_AGENCY + VERCEL_ORG_ID from process.env and
 * return a VercelClient. Throws if either is missing so the caller can
 * surface a typed "missing creds" condition rather than silently issuing
 * unauthenticated API calls. The error names BOTH env vars so an operator
 * sees the full required set even if only one is set.
 */
export function defaultVercelClient(): VercelClient {
  const token = process.env.VERCEL_TOKEN_WOLFPACK_AGENCY ?? "";
  const teamId = process.env.VERCEL_ORG_ID ?? "";
  if (!token || !teamId) {
    throw new Error(
      "Vercel credentials missing: VERCEL_TOKEN_WOLFPACK_AGENCY and VERCEL_ORG_ID must both be set",
    );
  }
  return { token, teamId, fetch: globalThis.fetch };
}

/**
 * Build a Vercel v9 URL with the teamId query param attached. All v9
 * endpoints require teamId when the token is team-scoped (ours is).
 * The name/id segment is URL-encoded so slashes, spaces, or unusual
 * characters don't silently break the path — Vercel project names permit
 * lowercase letters/digits/hyphens up to 100 chars, but callers may pass
 * legacy or user-supplied values, so we encode defensively.
 */
function buildUrl(client: VercelClient, segment: string): string {
  const encoded = encodeURIComponent(segment);
  const params = new URLSearchParams({ teamId: client.teamId });
  return `${VERCEL_API}/v9/projects/${encoded}?${params.toString()}`;
}

function authHeaders(client: VercelClient): HeadersInit {
  return {
    "Authorization": `Bearer ${client.token}`,
    "Content-Type": "application/json",
    "User-Agent": "wolfpack-instinct-sites",
  };
}

/**
 * GET /v9/projects/{name}?teamId=… — Vercel accepts either a project id
 * (prj_…) or a project name in this path segment.
 *
 * Returns null on 404 (project doesn't exist — the caller uses this to
 * decide whether to skip the DELETE entirely). Throws VercelApiError on
 * any other non-2xx so infrastructure failures surface loudly instead of
 * silently masquerading as "not found".
 */
export async function findProjectByName(
  client: VercelClient,
  name: string,
): Promise<VercelProject | null> {
  const res = await client.fetch(buildUrl(client, name), {
    method: "GET",
    headers: authHeaders(client),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VercelApiError(res.status, text);
  }
  const raw = (await res.json()) as {
    id: string;
    name: string;
    framework?: string | null;
    link?: { repo?: string; type?: string } | null;
    gitRepository?: { repo?: string; type?: string } | null;
  };
  // Vercel's response shape has evolved: newer accounts use `link` for the
  // attached git repo, older ones use `gitRepository`. Coerce both into
  // our single shape so callers don't branch on Vercel's versioning.
  const git = raw.gitRepository ?? raw.link ?? null;
  return {
    id: raw.id,
    name: raw.name,
    framework: raw.framework ?? null,
    gitRepository:
      git && git.repo && git.type
        ? { repo: git.repo, type: git.type }
        : null,
  };
}

/**
 * POST /v9/projects?teamId=… — create a new Vercel project for a client
 * site. Used by the Sites provisioning flow right after the GitHub repo is
 * created so Instinct has a `VERCEL_PROJECT_ID` to write onto the repo's
 * Actions secrets.
 *
 * `framework` defaults to "nextjs" since every wolfpack-site-template
 * derivative is a Next.js app. Callers may override for non-standard
 * templates (e.g. "gatsby", "vite") but today that's unused.
 *
 * Returns the new project's id (prj_…). Throws VercelApiError on any
 * non-2xx — including 409 "name already taken", which the orchestration
 * layer translates into an idempotency lookup via findProjectByName.
 */
export async function createProject(
  client: VercelClient,
  name: string,
  framework?: string,
): Promise<{ id: string; name: string }> {
  const params = new URLSearchParams({ teamId: client.teamId });
  const url = `${VERCEL_API}/v9/projects?${params.toString()}`;
  const res = await client.fetch(url, {
    method: "POST",
    headers: authHeaders(client),
    body: JSON.stringify({ name, framework: framework ?? "nextjs" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VercelApiError(res.status, text);
  }
  const raw = (await res.json()) as { id?: string; name?: string };
  if (!raw.id || !raw.name) {
    throw new VercelApiError(
      502,
      `createProject response malformed: ${JSON.stringify(raw).slice(0, 200)}`,
    );
  }
  return { id: raw.id, name: raw.name };
}

/**
 * DELETE /v9/projects/{idOrName}?teamId=… — idempotent.
 *
 * - 2xx  → { ok: true, alreadyGone: false }
 * - 404  → { ok: true, alreadyGone: true }  (treat as success; nothing to do)
 * - else → throws VercelApiError with the HTTP status preserved so callers
 *          can retry transient 5xx or escalate 403s.
 *
 * Idempotency matters: the "Delete permanently" action in sites.ts runs in
 * sequence with GitHub repo deletion + DB row removal. If the DB row is
 * gone but a retry fires, we must not block on a 404 from Vercel.
 */
export async function deleteProject(
  client: VercelClient,
  idOrName: string,
): Promise<{ ok: true; alreadyGone: boolean }> {
  const res = await client.fetch(buildUrl(client, idOrName), {
    method: "DELETE",
    headers: authHeaders(client),
  });
  if (res.status === 404) return { ok: true, alreadyGone: true };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VercelApiError(res.status, text);
  }
  return { ok: true, alreadyGone: false };
}
