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

export interface GithubClient {
  token: string;
  fetch: typeof fetch;
}

export function defaultGithubClient(): GithubClient {
  const token = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY ?? "";
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
): Promise<void> {
  // Need to look up existing sha so we don't 422 on overwrite.
  let sha: string | undefined;
  try {
    const existing = await gh<{ sha: string }>(
      client,
      "GET",
      `/repos/${repoFullName}/contents/${path}`,
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
