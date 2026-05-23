/**
 * Vercel API wrapper — read-only access to deployments and projects via a
 * single Wolfpack team token. Endpoints used:
 *   - GET /v6/deployments (recent deploys, optionally filtered by app/project name)
 *   - GET /v13/deployments/{idOrUrl} (single deploy detail)
 *   - GET /v9/projects (project list, used by the search provider)
 *
 * Auth: `VERCEL_API_TOKEN` (required to enable the integration).
 * Team scope: `VERCEL_TEAM_ID` (optional but recommended; without it the token
 *   defaults to the personal scope).
 *
 * Safety:
 *   - 5s AbortController timeout per call so a stalled Vercel API doesn't block
 *     the universal search fan-out.
 *   - Token never logged; errors are returned as `{ ok: false, error: string }`
 *     with headers stripped.
 *   - No mutating endpoints exposed. Read-only by design.
 */

const VERCEL_API_BASE = "https://api.vercel.com";
const FETCH_TIMEOUT_MS = 5_000;

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: "READY" | "ERROR" | "BUILDING" | "INITIALIZING" | "QUEUED" | "CANCELED";
  target: "production" | "preview" | "staging" | null;
  createdAt: number;
  readyAt?: number;
  meta?: {
    githubCommitMessage?: string;
    githubCommitRef?: string;
    githubCommitSha?: string;
  };
  inspectorUrl?: string;
  creator?: { username?: string };
}

export interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  latestDeployments?: VercelDeployment[];
}

export interface VercelResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

function getToken(): string {
  return process.env.VERCEL_API_TOKEN ?? "";
}

function getTeamId(): string {
  return process.env.VERCEL_TEAM_ID ?? "";
}

export function vercelIsConfigured(): boolean {
  return Boolean(getToken());
}

async function vercelFetch<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<VercelResult<T>> {
  const token = getToken();
  if (!token) {
    return { ok: false, error: "VERCEL_API_TOKEN not set" };
  }
  const teamId = getTeamId();
  const url = new URL(`${VERCEL_API_BASE}${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body?.error?.message) errMsg = body.error.message;
      } catch {
        // body wasn't JSON; ignore
      }
      return { ok: false, error: errMsg, statusCode: res.status };
    }
    const data = (await res.json()) as T;
    return { ok: true, data, statusCode: res.status };
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? "Vercel API timeout" : (err as Error).message;
    return { ok: false, error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export async function listDeployments(opts: {
  projectName?: string;
  limit?: number;
} = {}): Promise<VercelResult<{ deployments: VercelDeployment[] }>> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  return vercelFetch<{ deployments: VercelDeployment[] }>("/v6/deployments", {
    app: opts.projectName,
    limit,
  });
}

export async function listProjects(opts: { limit?: number } = {}): Promise<
  VercelResult<{ projects: VercelProject[] }>
> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return vercelFetch<{ projects: VercelProject[] }>("/v9/projects", { limit });
}

/** Build the Vercel dashboard URL for a deployment. Used by the widget for
 *  click-through. Allowlisted to vercel.com only. */
export function deploymentDashboardUrl(d: VercelDeployment): string {
  if (d.inspectorUrl && d.inspectorUrl.startsWith("https://vercel.com/")) {
    return d.inspectorUrl;
  }
  // Fallback: deployment URL on *.vercel.app
  const safe = d.url && /^[a-z0-9-]+\.vercel\.app$/i.test(d.url);
  return safe ? `https://${d.url}` : "https://vercel.com";
}
