/**
 * Repo-tree discovery for the static platform scan. Instead of seeding the scan
 * with a hardcoded handful of paths (which misses 90%+ of a real app's route /
 * page surface), this enumerates the target repo's ENTIRE tree via the GitHub
 * git/trees API (recursive), then filters down to the client UI / route source
 * worth scanning. The result feeds scanSource's `paths` so the scan covers every
 * page, route, layout, and client component in the repo, not a static seed.
 *
 * Like defaultReadFile in scan.ts, fetch is injectable (tests pass a stub) and
 * Bearer auth is only attached when a token resolves, so a private CLIENT repo's
 * tree is readable. NEVER throws - non-200, network error, abort, or malformed
 * JSON all yield `[]`, because an empty discovery is a normal (degraded) outcome
 * that should fall back to the seed, not crash the scan.
 *
 * AUTH: when a `workspaceId` is supplied the token is resolved through the
 * GitHub App layer (resolveGithubToken) - a per-client installation token when
 * that client has linked the App, otherwise the existing
 * GITHUB_TOKEN_WOLFPACK_AGENCY PAT. When no `workspaceId` is supplied the PAT is
 * used directly, so existing call sites that don't pass one behave EXACTLY as
 * before (zero regression for our own curated repos).
 */

import { resolveGithubToken } from "@/lib/github-app";

/** Default include patterns: page/route/layout files, app-dir source, and client components. */
const DEFAULT_INCLUDE: RegExp[] = [
  /\/(page|route|layout)\.(t|j)sx?$/,
  /\/app\/.+\.(t|j)sx$/,
  /\/components\/.+\.(t|j)sx$/,
];

/** Always-excluded paths: test files, node_modules, and type-declaration files. */
const EXCLUDE: RegExp[] = [
  /\/__tests__\//,
  /\.test\./,
  /\.spec\./,
  /(^|\/)node_modules\//,
  /\.d\.ts$/,
];

interface TreeEntry {
  path?: unknown;
  type?: unknown;
}

interface TreeResponse {
  tree?: unknown;
  truncated?: unknown;
}

export interface DiscoverOpts {
  include?: RegExp[];
  max?: number;
  fetchImpl?: typeof fetch;
  /** When set, the GitHub token is resolved per-client through the GitHub App
   *  layer (installation token if linked, else the PAT). Absent → PAT only. */
  workspaceId?: string | null;
  /** Injectable token resolver for tests. Defaults to resolveGithubToken. */
  resolveToken?: (workspaceId: string | null | undefined) => Promise<string>;
}

export async function discoverRepoFiles(
  owner: string,
  repo: string,
  ref?: string,
  opts?: DiscoverOpts,
): Promise<string[]> {
  const branch = ref ?? "main";
  const include = opts?.include ?? DEFAULT_INCLUDE;
  const max = opts?.max ?? 300;
  const doFetch = opts?.fetchImpl ?? fetch;
  /* Resolve the token per-client when a workspaceId is supplied (installation
     token if the client linked the App, else the PAT). With no workspaceId we
     read the PAT directly - identical to the pre-App behavior. Resolution
     never throws; if it ever did we degrade to no auth (public repos only). */
  let token: string | undefined;
  if (opts?.workspaceId) {
    const resolve = opts.resolveToken ?? resolveGithubToken;
    token = await resolve(opts.workspaceId).catch(() => undefined);
  } else {
    token = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await doFetch(url, { headers, signal: controller.signal });
    if (res.status !== 200) return [];

    const body = (await res.json()) as TreeResponse;
    const tree = Array.isArray(body?.tree) ? (body.tree as TreeEntry[]) : [];

    const out: string[] = [];
    for (const entry of tree) {
      if (entry?.type !== "blob") continue;
      const path = entry?.path;
      if (typeof path !== "string") continue;
      if (EXCLUDE.some((rx) => rx.test(path))) continue;
      if (!include.some((rx) => rx.test(path))) continue;
      out.push(path);
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
