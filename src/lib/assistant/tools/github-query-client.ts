/**
 * Read-only GitHub query client for assistant tools.
 *
 * Separate from github-client.ts (which mutates: createRepo, putFile,
 * triggerWorkflow) because the assistant only reads. Splitting keeps the
 * blast radius small — none of these helpers can write, fire a workflow,
 * or delete a repo even if the LLM tries to call them with the wrong
 * args.
 *
 * Auth: same fine-grained PAT (GITHUB_TOKEN_WOLFPACK_AGENCY) the Sites
 * flow already provisions. The PAT scopes for read are:
 *   - Metadata: read   (always required)
 *   - Pull requests: read
 *   - Issues: read
 *   - Actions: read
 *
 * SECURITY: server-only. Never import from a "use client" component.
 */
import type { GithubClient } from "@/lib/github-client";
import { defaultGithubClient } from "@/lib/github-client";

export interface PullRequestSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  user: string;
  repo: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  user: string;
  repo: string;
  html_url: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  status: string; // queued|in_progress|completed
  conclusion: string | null; // success|failure|cancelled|...
  event: string;
  head_branch: string | null;
  actor: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export type GithubQueryFailureCode = "auth_failed" | "rate_limited" | "not_found" | "internal";

export interface GithubQueryFailure {
  ok: false;
  code: GithubQueryFailureCode;
  message: string;
}

export interface GithubQuerySuccess<R> {
  ok: true;
  data: R;
  durationMs: number;
}

export type GithubQueryResult<R> = GithubQuerySuccess<R> | GithubQueryFailure;

/** Map a fetch Response error into a typed failure. Centralized so every
 *  tool surfaces the same code for the same condition. */
function classifyError(status: number, body: string): GithubQueryFailure {
  if (status === 401) return { ok: false, code: "auth_failed", message: "GitHub returned 401 — PAT missing or expired" };
  if (status === 403) {
    if (/rate limit/i.test(body)) return { ok: false, code: "rate_limited", message: "GitHub rate limit hit" };
    return { ok: false, code: "auth_failed", message: "GitHub returned 403 — PAT lacks scope" };
  }
  if (status === 404) return { ok: false, code: "not_found", message: "GitHub 404 — repo or resource not found" };
  return { ok: false, code: "internal", message: `GitHub ${status}: ${body.slice(0, 200)}` };
}

async function ghGet<T>(
  client: GithubClient,
  path: string,
): Promise<GithubQueryResult<T>> {
  if (!client.token) {
    return { ok: false, code: "auth_failed", message: "GITHUB_TOKEN_WOLFPACK_AGENCY not set" };
  }
  const start = Date.now();
  let res: Response;
  try {
    res = await client.fetch(`https://api.github.com${path}`, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${client.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "wolfpack-instinct-assistant",
      },
    });
  } catch (err) {
    return { ok: false, code: "internal", message: `network error: ${(err as Error).message}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return classifyError(res.status, body);
  }
  const json = (await res.json()) as T;
  return { ok: true, data: json, durationMs: Date.now() - start };
}

/* ---------------------------------------------------------------------
 * Search /search/issues for PRs and issues.
 *
 * GitHub's search/issues endpoint covers both — they're discriminated
 * by the `is:pr` vs `is:issue` qualifier. We expose two helpers so the
 * caller doesn't have to remember which qualifier to add.
 * ------------------------------------------------------------------- */

interface SearchIssuesItem {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  user: { login: string };
  repository_url: string;
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  pull_request?: object; // present when this issue IS a PR
}

interface SearchResponse<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}

function repoFromUrl(url: string): string {
  // https://api.github.com/repos/owner/name → owner/name
  const m = /\/repos\/([^/]+\/[^/]+)$/.exec(url);
  return m ? m[1] : "";
}

export async function searchPullRequests(
  opts: {
    state?: "open" | "closed";
    repo?: string; // "owner/name" or just "name" — we prefix the org if no slash
    author?: string;
    org?: string; // default "the-wolfpack-agency"
    perPage?: number;
  },
  client: GithubClient = defaultGithubClient(),
): Promise<GithubQueryResult<PullRequestSummary[]>> {
  const org = opts.org ?? "the-wolfpack-agency";
  const qualifiers: string[] = ["is:pr"];
  if (opts.state) qualifiers.push(`is:${opts.state}`);
  if (opts.repo) {
    const repo = opts.repo.includes("/") ? opts.repo : `${org}/${opts.repo}`;
    qualifiers.push(`repo:${repo}`);
  } else {
    qualifiers.push(`org:${org}`);
  }
  if (opts.author) qualifiers.push(`author:${opts.author}`);
  qualifiers.push("sort:updated-desc");
  const q = encodeURIComponent(qualifiers.join(" "));
  const perPage = Math.min(Math.max(opts.perPage ?? 10, 1), 25);
  const res = await ghGet<SearchResponse<SearchIssuesItem>>(
    client,
    `/search/issues?q=${q}&per_page=${perPage}`,
  );
  if (!res.ok) return res;
  const items: PullRequestSummary[] = res.data.items.map((it) => ({
    number: it.number,
    title: it.title,
    state: it.state,
    draft: it.draft ?? false,
    user: it.user.login,
    repo: repoFromUrl(it.repository_url),
    html_url: it.html_url,
    created_at: it.created_at,
    updated_at: it.updated_at,
  }));
  return { ok: true, data: items, durationMs: res.durationMs };
}

export async function searchIssues(
  opts: {
    state?: "open" | "closed";
    repo?: string;
    label?: string;
    author?: string;
    org?: string;
    perPage?: number;
  },
  client: GithubClient = defaultGithubClient(),
): Promise<GithubQueryResult<IssueSummary[]>> {
  const org = opts.org ?? "the-wolfpack-agency";
  const qualifiers: string[] = ["is:issue"];
  if (opts.state) qualifiers.push(`is:${opts.state}`);
  if (opts.repo) {
    const repo = opts.repo.includes("/") ? opts.repo : `${org}/${opts.repo}`;
    qualifiers.push(`repo:${repo}`);
  } else {
    qualifiers.push(`org:${org}`);
  }
  if (opts.label) qualifiers.push(`label:"${opts.label}"`);
  if (opts.author) qualifiers.push(`author:${opts.author}`);
  qualifiers.push("sort:updated-desc");
  const q = encodeURIComponent(qualifiers.join(" "));
  const perPage = Math.min(Math.max(opts.perPage ?? 10, 1), 25);
  const res = await ghGet<SearchResponse<SearchIssuesItem>>(
    client,
    `/search/issues?q=${q}&per_page=${perPage}`,
  );
  if (!res.ok) return res;
  const items: IssueSummary[] = res.data.items
    /* defensive: /search/issues sometimes returns PRs even with is:issue
       — the `pull_request` key is the disambiguator. */
    .filter((it) => !it.pull_request)
    .map((it) => ({
      number: it.number,
      title: it.title,
      state: it.state,
      user: it.user.login,
      repo: repoFromUrl(it.repository_url),
      html_url: it.html_url,
      labels: (it.labels ?? []).map((l) => l.name),
      created_at: it.created_at,
      updated_at: it.updated_at,
    }));
  return { ok: true, data: items, durationMs: res.durationMs };
}

interface WorkflowRunsResponse {
  total_count: number;
  workflow_runs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    event: string;
    head_branch: string | null;
    actor: { login: string };
    html_url: string;
    created_at: string;
    updated_at: string;
  }>;
}

export async function recentWorkflowRuns(
  opts: {
    repo: string; // required — workflow runs need a specific repo
    status?: "success" | "failure" | "in_progress" | "queued" | "cancelled";
    org?: string;
    perPage?: number;
  },
  client: GithubClient = defaultGithubClient(),
): Promise<GithubQueryResult<WorkflowRunSummary[]>> {
  const org = opts.org ?? "the-wolfpack-agency";
  const repo = opts.repo.includes("/") ? opts.repo : `${org}/${opts.repo}`;
  const perPage = Math.min(Math.max(opts.perPage ?? 10, 1), 25);
  const params = new URLSearchParams();
  params.set("per_page", String(perPage));
  /* GitHub treats "status" as a single field that overloads run-state +
     conclusion: success/failure/cancelled/skipped are conclusions, and
     queued/in_progress/completed are statuses. The API accepts both
     vocabularies via the same query param. */
  if (opts.status) params.set("status", opts.status);
  const res = await ghGet<WorkflowRunsResponse>(
    client,
    `/repos/${repo}/actions/runs?${params.toString()}`,
  );
  if (!res.ok) return res;
  const items: WorkflowRunSummary[] = res.data.workflow_runs.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    head_branch: r.head_branch,
    actor: r.actor?.login ?? "unknown",
    html_url: r.html_url,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  return { ok: true, data: items, durationMs: res.durationMs };
}
