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

export async function putFile(
  client: GithubClient,
  repoFullName: string,
  path: string,
  content: string,
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
  await gh(client, "PUT", `/repos/${repoFullName}/contents/${path}`, {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha,
  });
}

export async function triggerWorkflow(
  client: GithubClient,
  repoFullName: string,
  workflowFile: string,
  ref: string,
): Promise<{ run_id: string | null }> {
  await gh(
    client,
    "POST",
    `/repos/${repoFullName}/actions/workflows/${workflowFile}/dispatches`,
    { ref },
  );
  // GitHub doesn't return the run id from a dispatch — caller must poll
  // /actions/runs if needed. For our purposes the webhook reports it.
  return { run_id: null };
}
