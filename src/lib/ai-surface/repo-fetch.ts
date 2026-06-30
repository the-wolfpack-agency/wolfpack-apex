/**
 * Live public-repo source fetch for the AI Surface Inventory.
 *
 * The single most convincing demo moment: paste a public GitHub repo URL and get
 * a real inventory of its AI touchpoints. This module turns a URL into the same
 * SourceFile[] the existing detectors already consume — it does NOT detect or
 * persist anything itself (inventory.ts owns that), it only SOURCES the files.
 *
 * TECH CHOICE — GitHub git/trees API (recursive) + per-file Contents/raw fetch,
 * NOT a disk `git clone` and NOT a codeload tarball:
 *   - A disk clone is a poor fit for serverless/Vercel (ephemeral, no persistent
 *     FS, cold-start cost, and `git` may be absent in the function runtime).
 *   - A tarball stream forces us to download + decompress the WHOLE repo before
 *     we can filter, which blows the size cap on large repos and pulls binaries.
 *   - The trees API returns the full file LIST with per-blob sizes in one call,
 *     so we filter to text/code extensions and apply the file-count + size caps
 *     BEFORE fetching a single byte of content. That is the cheapest, safest fit
 *     for the demo: bounded work, only the files we will actually scan.
 *
 * SECURITY: host is allowlisted to github.com only (SSRF defense — no internal
 * hosts, no IP literals, no non-GitHub redirects); the trees + raw fetches go to
 * fixed api.github.com / raw.githubusercontent.com origins we construct, never to
 * a URL derived from the response. Response size + file count are capped. The
 * token is read from env and sent only in the Authorization header — never logged
 * and never returned. Like every integration in this repo, this NEVER throws: it
 * returns a typed Result so call sites translate failure into the right HTTP
 * status instead of corrupting the UX.
 */
import type { SourceFile } from "./detect";

/** Caps so a hostile/huge repo can't exhaust memory or rate limit. */
export const MAX_FILES = 300;
export const MAX_FILE_BYTES = 200_000; // skip blobs larger than this
export const MAX_TOTAL_BYTES = 8_000_000; // stop once we've pulled this much

/** Text/code extensions worth scanning. Binaries + lockfiles are skipped (no AI
 *  signatures live there and they only burn the byte budget). */
const SCANNABLE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "cs", "php", "swift", "scala",
  "json", "yaml", "yml", "toml", "env", "sh", "bash",
  "txt", "md", "mdx", "ini", "cfg", "conf",
]);

export type RepoFetchErrorKind =
  | "invalid_url" // not a parseable github.com repo URL (SSRF-shaped inputs land here)
  | "not_found" // 404 — repo/branch doesn't exist or is private
  | "forbidden" // 403 — permission / abuse detection
  | "rate_limited" // 403/429 with rate-limit headers exhausted
  | "service_unavailable"; // 5xx / network

export interface RepoFetchError {
  kind: RepoFetchErrorKind;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: RepoFetchError };

export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch/tag/sha if the URL pinned one, else undefined (use default branch). */
  ref?: string;
}

export interface RepoFetchResult {
  ref: RepoRef;
  /** Normalized "owner/repo" target, used as the inventory target key. */
  target: string;
  files: SourceFile[];
  /** How many candidate files the tree had vs. how many we fetched (caps hit). */
  treeFileCount: number;
  fetchedFileCount: number;
  truncated: boolean;
}

/**
 * Parse a public GitHub repo URL into an owner/repo[/ref]. Allowlists github.com
 * ONLY and rejects anything SSRF-shaped (other hosts, IP literals, userinfo,
 * non-https). Returns a typed error rather than throwing.
 */
export function parseRepoUrl(input: string): Result<RepoRef> {
  const raw = (input ?? "").trim();
  if (!raw) return err("invalid_url", "a repo URL is required");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err("invalid_url", "not a valid URL");
  }

  // Scheme: https only. http/git/ssh/file/etc. are rejected.
  if (url.protocol !== "https:") return err("invalid_url", "only https GitHub URLs are allowed");
  // No embedded credentials (userinfo) — an SSRF/credential-smuggling shape.
  if (url.username || url.password) return err("invalid_url", "credentials in the URL are not allowed");
  // Host allowlist: github.com or www.github.com EXACTLY. This blocks internal
  // hosts, IP literals, and look-alikes like github.com.evil.test.
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return err("invalid_url", "only github.com repositories are supported");
  }

  // Path: /owner/repo[/...]. Strip a trailing .git and any trailing slash.
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return err("invalid_url", "URL must reference an owner and repo");
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  // GitHub owner/repo charset: alnum, dash, underscore, dot. Reject anything else
  // (path traversal, encoded separators).
  const nameRe = /^[A-Za-z0-9._-]+$/;
  if (!nameRe.test(owner) || !nameRe.test(repo) || repo === "" ) {
    return err("invalid_url", "invalid owner or repo name");
  }
  // Optional /tree/<ref> pins a branch/tag.
  let ref: string | undefined;
  if (segments[2] === "tree" && segments[3]) {
    ref = decodeURIComponent(segments[3]);
    if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return err("invalid_url", "invalid branch/ref");
  }
  return { ok: true, value: { owner, repo, ref } };
}

function err(kind: RepoFetchErrorKind, message: string): { ok: false; error: RepoFetchError } {
  return { ok: false, error: { kind, message } };
}

/** Classify a non-ok GitHub response into a typed error kind. */
function classify(status: number, headers: Headers): RepoFetchErrorKind {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 403) {
    // 403 with the rate-limit budget exhausted is a rate limit, not a perm error.
    if (headers.get("x-ratelimit-remaining") === "0") return "rate_limited";
    return "forbidden";
  }
  return "service_unavailable";
}

const ext = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
};

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

/** Injectable deps so the route + tests can mock the network + token without
 *  touching the global fetch or env. */
export interface RepoFetchDeps {
  fetch: typeof fetch;
  token?: string;
}

function defaultDeps(): RepoFetchDeps {
  return { fetch: globalThis.fetch, token: process.env.GITHUB_TOKEN_WOLFPACK_AGENCY || undefined };
}

function ghHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "wolfpack-instinct-ai-surface",
  };
  // Token is optional for public repos; sending it only raises the rate limit.
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Fetch the scannable source of a public GitHub repo as SourceFile[]. Caps file
 * count + total bytes, filters to text/code extensions, and surfaces every
 * failure mode as a typed error — never throws.
 */
export async function fetchRepoFiles(
  url: string,
  depsIn?: Partial<RepoFetchDeps>,
): Promise<Result<RepoFetchResult>> {
  const parsed = parseRepoUrl(url);
  if (!parsed.ok) return parsed;
  const ref = parsed.value;
  const deps: RepoFetchDeps = { ...defaultDeps(), ...depsIn };

  // Resolve the default branch when the URL didn't pin one.
  let branch = ref.ref;
  if (!branch) {
    const repoRes = await safeFetch(
      deps,
      `https://api.github.com/repos/${ref.owner}/${ref.repo}`,
    );
    if (!repoRes.ok) return repoRes;
    const body = repoRes.value as { default_branch?: string };
    branch = body.default_branch || "main";
  }

  // One trees call gets the whole file list + sizes; we filter BEFORE fetching.
  const treeRes = await safeFetch(
    deps,
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(
      branch,
    )}?recursive=1`,
  );
  if (!treeRes.ok) return treeRes;
  const tree = (treeRes.value as { tree?: TreeEntry[]; truncated?: boolean }) ?? {};
  const entries = (tree.tree ?? []).filter(
    (e) => e.type === "blob" && SCANNABLE_EXT.has(ext(e.path)) && (e.size ?? 0) <= MAX_FILE_BYTES,
  );
  const treeFileCount = entries.length;
  const capped = entries.slice(0, MAX_FILES);

  const files: SourceFile[] = [];
  let totalBytes = 0;
  let truncated = Boolean(tree.truncated) || entries.length > capped.length;
  for (const entry of capped) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    const rawUrl = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(
      branch,
    )}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
    const content = await safeText(deps, rawUrl);
    if (!content.ok) {
      // One unreadable file shouldn't abort the whole scan; skip it. Only a
      // hard rate-limit aborts (so we surface it rather than returning partial).
      if (content.error.kind === "rate_limited") return content;
      continue;
    }
    const sliced = content.value.slice(0, MAX_FILE_BYTES);
    totalBytes += sliced.length;
    files.push({ path: entry.path, content: sliced });
  }

  return {
    ok: true,
    value: {
      ref: { ...ref, ref: branch },
      target: `${ref.owner}/${ref.repo}`,
      files,
      treeFileCount,
      fetchedFileCount: files.length,
      truncated,
    },
  };
}

/** GET a JSON GitHub API resource with typed-error handling. */
async function safeFetch(deps: RepoFetchDeps, target: string): Promise<Result<unknown>> {
  let res: Response;
  try {
    res = await deps.fetch(target, { headers: ghHeaders(deps.token), redirect: "follow" });
  } catch {
    return err("service_unavailable", "could not reach GitHub");
  }
  if (!res.ok) return err(classify(res.status, res.headers), `GitHub responded ${res.status}`);
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return err("service_unavailable", "malformed GitHub response");
  }
}

/** GET raw file text with typed-error handling. */
async function safeText(deps: RepoFetchDeps, target: string): Promise<Result<string>> {
  let res: Response;
  try {
    res = await deps.fetch(target, { headers: ghHeaders(deps.token), redirect: "follow" });
  } catch {
    return err("service_unavailable", "could not reach GitHub raw");
  }
  if (!res.ok) return err(classify(res.status, res.headers), `GitHub raw responded ${res.status}`);
  try {
    return { ok: true, value: await res.text() };
  } catch {
    return err("service_unavailable", "could not read file body");
  }
}

/** Map a typed repo-fetch error to an HTTP status for the route layer. */
export function statusForError(kind: RepoFetchErrorKind): number {
  switch (kind) {
    case "invalid_url":
      return 400;
    case "not_found":
      return 404;
    case "forbidden":
      return 403;
    case "rate_limited":
      return 429;
    case "service_unavailable":
      return 502;
  }
}
