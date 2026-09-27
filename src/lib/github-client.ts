/**
 * Thin GitHub API wrapper for the Sites feature.
 *
 * Three operations only:
 *   1. createRepoFromTemplate — clone wolfpack-site-template under the org
 *   2. putFile               — commit a file (the brief) to a repo
 *   3. triggerWorkflow       — fire the canary-deploy workflow
 *
 * Designed to be mockable: every call goes through GithubClient.fetch
 * which can be swapped in tests with a stub. The default client uses the
 * GITHUB_TOKEN_WOLFPACK_AGENCY env var (org-scoped fine-grained PAT with
 * repo:contents, repo:administration, actions:write — nothing else).
 *
 * SECURITY NOTE: this module is server-only. Importing it from a client
 * component will leak the token into the browser bundle. The auth gate on
 * /api/sites/* must be checked before any function here is called.
 */

import { resolveGithubToken } from "@/lib/github-app";

export interface GithubClient {
  token: string;
  fetch: typeof fetch;
}

export function defaultGithubClient(): GithubClient {
  const token = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY ?? "";
  return { token, fetch: globalThis.fetch };
}

/**
 * Per-workspace GitHub client.
 *
 * Identical to defaultGithubClient() EXCEPT the token is resolved through the
 * GitHub App layer: when the App is configured and the workspace has a linked
 * installation, this is a short-lived installation token scoped to JUST that
 * client's repos; otherwise it falls back to the same PAT defaultGithubClient()
 * uses today (resolveGithubToken's fallback guarantee). Use this for any
 * scan / remediation-PR operation done ON BEHALF OF a specific client so a
 * single shared PAT is not the only key in play. Async because minting the
 * installation token is a network round trip (cached ~1h). NEVER throws.
 */
export async function workspaceGithubClient(
  workspaceId: string | null | undefined,
): Promise<GithubClient> {
  const token = await resolveGithubToken(workspaceId);
  return { token, fetch: globalThis.fetch };
}

async function gh<T = unknown>(
  client: GithubClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!client.token) {
    throw new Error(
      "GITHUB_TOKEN_WOLFPACK_AGENCY not set — refusing to call GitHub API in dev",
    );
  }
  const res = await client.fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${client.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "wolfpack-instinct-sites",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface CreatedRepo {
  full_name: string;
  html_url: string;
}

export async function createRepoFromTemplate(
  client: GithubClient,
  templateOwner: string,
  templateRepo: string,
  targetOwner: string,
  targetRepo: string,
): Promise<CreatedRepo> {
  return gh<CreatedRepo>(
    client,
    "POST",
    `/repos/${templateOwner}/${templateRepo}/generate`,
    {
      owner: targetOwner,
      name: targetRepo,
      description: `Wolfpack Agency client site — ${targetRepo}`,
      include_all_branches: false,
      private: true,
    },
  );
}

/**
 * PUT a file into a GitHub repo via the Contents API.
 *
 * Accepts either a text string (encoded as UTF-8 → base64) OR a Buffer
 * of raw bytes (base64 directly — no double-encoding, preserves binary
 * integrity). The asset upload path was silently corrupting images
 * before 2026-04-18 because it was passing `buffer.toString("base64")`
 * as the `content` string, which this helper then UTF-8-encoded and
 * base64-encoded AGAIN — garbage bytes committed, 404s in the iframe.
 */
export async function putFile(
  client: GithubClient,
  repoFullName: string,
  path: string,
  content: string | Buffer,
  message: string,
  branch?: string,
): Promise<void> {
  // Need to look up existing sha so we don't 422 on overwrite. Scope the lookup
  // to the target branch so a file that exists on the base but not the new branch
  // is created, not 422'd.
  let sha: string | undefined;
  try {
    const q = branch ? `?ref=${encodeURIComponent(branch)}` : "";
    const existing = await gh<{ sha: string }>(
      client,
      "GET",
      `/repos/${repoFullName}/contents/${path}${q}`,
    );
    sha = existing.sha;
  } catch {
    // file doesn't exist yet — create
  }
  const base64 = Buffer.isBuffer(content)
    ? content.toString("base64")
    : Buffer.from(content, "utf-8").toString("base64");
  await gh(client, "PUT", `/repos/${repoFullName}/contents/${path}`, {
    message,
    content: base64,
    sha,
    ...(branch ? { branch } : {}),
  });
}

/** Create a new branch off `fromBranch` (defaults to the repo's default branch).
 *  Idempotent-ish: a 422 (ref exists) is swallowed so a retried remediation reuses
 *  the branch instead of failing. */
export async function createBranch(
  client: GithubClient,
  repoFullName: string,
  newBranch: string,
  fromBranch?: string,
): Promise<void> {
  const base = fromBranch ?? (await gh<{ default_branch: string }>(client, "GET", `/repos/${repoFullName}`)).default_branch;
  const ref = await gh<{ object: { sha: string } }>(client, "GET", `/repos/${repoFullName}/git/ref/heads/${encodeURIComponent(base)}`);
  try {
    await gh(client, "POST", `/repos/${repoFullName}/git/refs`, {
      ref: `refs/heads/${newBranch}`,
      sha: ref.object.sha,
    });
  } catch (err) {
    if (!/422/.test((err as Error).message)) throw err; // ref already exists -> reuse
  }
}

export interface OpenedPullRequest {
  html_url: string;
  number: number;
}

/** Open a pull request. NEVER merges: a PR is the human-review checkpoint. */
export async function openPullRequest(
  client: GithubClient,
  repoFullName: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<OpenedPullRequest> {
  return gh<OpenedPullRequest>(client, "POST", `/repos/${repoFullName}/pulls`, {
    title,
    head,
    base,
    body,
  });
}

/**
 * DELETE a repository. Idempotent: 404 is treated as "already gone"
 * and returns `{ alreadyGone: true }` instead of throwing. Requires a
 * PAT with Administration: write on the target repo. Used by the
 * site.hard_delete flow so archiving a client site can optionally
 * clean up the orphaned GitHub repo that was provisioned for it.
 */
export async function deleteRepo(
  client: GithubClient,
  repoFullName: string,
): Promise<{ ok: true; alreadyGone: boolean }> {
  try {
    await gh(client, "DELETE", `/repos/${repoFullName}`);
    return { ok: true, alreadyGone: false };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("→ 404")) return { ok: true, alreadyGone: true };
    throw err;
  }
}

/**
 * Enable GitHub Actions on a repository. New repos created from a
 * template in orgs that default Actions off land in a disabled state,
 * which makes ``/actions/workflows/:id/dispatches`` 404 until a human
 * clicks the "Enable" button in the Actions tab. Calling this right
 * after ``createRepoFromTemplate`` removes the manual step.
 *
 * Requires PAT Administration: write on the target repo.
 */
export async function enableActions(
  client: GithubClient,
  repoFullName: string,
): Promise<void> {
  await gh(client, "PUT", `/repos/${repoFullName}/actions/permissions`, {
    enabled: true,
    allowed_actions: "all",
  });
}

export interface CheckRun {
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | timed_out | action_required | skipped | null */
  conclusion: string | null;
  /** GitHub's rendered check output - the summary/title is what a fixer needs to
   *  know WHY a check failed. Present on most Actions check runs. */
  output?: { title?: string | null; summary?: string | null } | null;
}

/** List the check runs for a commit / branch / PR head ref. Used to read a
 *  factory PR's CI status back into Instinct. */
export async function listCheckRuns(
  client: GithubClient,
  repoFullName: string,
  ref: string,
): Promise<CheckRun[]> {
  const res = await gh<{ check_runs?: CheckRun[] }>(
    client,
    "GET",
    `/repos/${repoFullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
  );
  return res.check_runs ?? [];
}

export async function triggerWorkflow(
  client: GithubClient,
  repoFullName: string,
  workflowFile: string,
  ref: string,
  inputs?: Record<string, string>,
): Promise<{ run_id: string | null }> {
  // Dispatching a workflow on a freshly-created repo sometimes races
  // GitHub's workflow indexer — the file is committed but the dispatch
  // API returns 404 for a second or two. Retry briefly on 404 before
  // surfacing the error.
  //
  // `inputs` maps to the workflow_dispatch `inputs` block. canary-deploy.yml
  // exposes a `deploy_id` input that the "Notify Instinct" step uses to
  // correlate the webhook callback with the instinct_site_deploys row; without
  // it, the webhook fires the early-exit branch and preview_url never
  // propagates back to the project.
  const body: Record<string, unknown> = { ref };
  if (inputs && Object.keys(inputs).length > 0) body.inputs = inputs;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await gh(
        client,
        "POST",
        `/repos/${repoFullName}/actions/workflows/${workflowFile}/dispatches`,
        body,
      );
      return { run_id: null };
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message;
      if (!msg.includes("→ 404")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Fetch a single file's decoded text from a repo (Contents API). Returns null on
 * 404 (file does not exist) so a caller can treat "not present" as "no context"
 * rather than an error. Other failures throw. Used to give the code factory
 * repo-aware context: the existing content of the files a prompt names.
 */
export async function fetchFileContent(
  client: GithubClient,
  repoFullName: string,
  path: string,
  ref?: string,
): Promise<string | null> {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  try {
    const res = await gh<{ content?: string; encoding?: string; type?: string }>(
      client,
      "GET",
      `/repos/${repoFullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}${q}`,
    );
    if (res.type !== "file" || typeof res.content !== "string") return null;
    return Buffer.from(res.content, (res.encoding as BufferEncoding) || "base64").toString("utf8");
  } catch (err) {
    if ((err as Error).message.includes("→ 404")) return null;
    throw err;
  }
}

/**
 * Fetch a pull request's unified diff. GitHub returns raw diff text (not JSON)
 * when the Accept header requests the diff media type, so this bypasses the JSON
 * gh() helper. Used by the PR-gate webhook to run the deterministic gate over
 * exactly what a PR changes, no matter which AI or human authored it.
 */
export async function fetchPullRequestDiff(
  client: GithubClient,
  repoFullName: string,
  prNumber: number,
): Promise<string> {
  if (!client.token) throw new Error("no GitHub token for diff fetch");
  const res = await client.fetch(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github.v3.diff",
        Authorization: `Bearer ${client.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "wolfpack-instinct-secure-agent",
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`github diff pulls/${prNumber} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.text();
}

export interface CheckRunInput {
  headSha: string;
  name: string;
  conclusion: "success" | "action_required" | "neutral" | "failure";
  title: string;
  summary: string;
  detailsUrl?: string;
}

/**
 * Post a completed Check Run to a PR's head commit. This is the signal the
 * client sees on every PR with ZERO setup on their side: they install the App,
 * and the gate's verdict appears as a check. Making it a REQUIRED check that
 * blocks merge is the client's one optional branch-protection step.
 *
 * Requires the App's checks:write permission.
 */
export async function createCheckRun(
  client: GithubClient,
  repoFullName: string,
  input: CheckRunInput,
): Promise<{ id: number }> {
  return gh<{ id: number }>(client, "POST", `/repos/${repoFullName}/check-runs`, {
    name: input.name,
    head_sha: input.headSha,
    status: "completed",
    conclusion: input.conclusion,
    ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    output: { title: input.title, summary: input.summary },
  });
}

/**
 * Leave a single issue comment on a PR. Used so a BLOCK is visible even when the
 * client has not (yet) made the gate a required status check: value from just
 * the install. Best-effort; requires pull_requests:write (already held to open
 * PRs).
 */
export async function createPrComment(
  client: GithubClient,
  repoFullName: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await gh(client, "POST", `/repos/${repoFullName}/issues/${prNumber}/comments`, { body });
}
