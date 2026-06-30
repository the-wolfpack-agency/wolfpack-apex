/**
 * Production Release Gate - make "what is blocking a production deploy" VISIBLE
 * and give an operator a single in-product control to PROMOTE ready code to prod.
 *
 * THE PROBLEM THIS SOLVES
 *
 *   Production deploys on merge to `main`. An open PR targeting `main` can sit
 *   for hours waiting on a review, a failing check, or a merge conflict - and
 *   no one is told. The block is invisible: the only way to know is to open
 *   GitHub and read every open PR by hand. This lib turns that invisible,
 *   manual, hours-late state into a typed, plain-language status the UI and the
 *   notify stream consume, plus a fail-closed promote action.
 *
 * TWO NON-NEGOTIABLES (this is a production-promotion control, not a dashboard):
 *
 *   1. HONEST DEGRADE on read. If we cannot reach GitHub or it errors, we
 *      return `degraded: { detail }` with an EMPTY blocking list - we NEVER
 *      return a clean empty gate (which reads as "all clear, nothing blocking
 *      prod") when the truth is "we could not check." A silent all-clear on a
 *      failed check is the exact lie that lets a broken deploy ship.
 *
 *   2. FAIL CLOSED on promote. `promoteChange` re-fetches the PR and merges
 *      ONLY when it is genuinely mergeable with green checks (state
 *      `ready_to_merge`). A PR that is awaiting approval, has running/failing
 *      checks, or has a conflict is REFUSED with a typed reason. We never merge
 *      a not-ready PR, and we never trust the list-time state - we re-verify at
 *      promote time because checks can flip between list and click.
 *
 * REUSE: this calls the SAME GitHub client the Sites + assistant flows already
 * use (`src/lib/github-client.ts`, token GITHUB_TOKEN_WOLFPACK_AGENCY). No new
 * GitHub dependency. The mergeStateStatus + reviewDecision signals come from
 * GitHub's GraphQL API (the REST PR object does not expose mergeStateStatus or
 * reviewDecision), so we issue ONE GraphQL query through the injected client's
 * fetch. Everything is dependency-injected (the client + a `now()` clock) so the
 * tests run with zero network and deterministic age math.
 *
 * SECURITY: server-only. The PAT must never reach a client bundle. The route
 * layer gates every call behind a capability before this lib runs.
 */

import type { GithubClient } from "@/lib/github-client";
import { defaultGithubClient } from "@/lib/github-client";

/**
 * The five states a built change can be in relative to the production branch.
 * Ordered roughly worst-to-ready; only `ready_to_merge` is promotable.
 */
export type ReleaseBlockState =
  | "awaiting_approval"
  | "checks_running"
  | "checks_failing"
  | "merge_conflict"
  | "ready_to_merge";

/** One open PR targeting the production branch, with a plain-language reason. */
export interface BlockingChange {
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  state: ReleaseBlockState;
  /** Plain-language, operator-facing reason. NEVER a GitHub enum verbatim. */
  reason: string;
  /** Whole + fractional hours since the PR was opened. */
  ageHours: number;
}

/** The whole gate: what is blocking prod right now, or an honest degrade. */
export interface ReleaseGateStatus {
  productionBranch: string;
  blocking: BlockingChange[];
  /** ISO-8601 timestamp of when the gate was computed. */
  checkedAt: string;
  /**
   * Present IFF we could not actually determine the gate (GitHub unreachable /
   * errored). When set, `blocking` is empty NOT because nothing is blocking but
   * because we could not check. Consumers MUST surface this, never treat it as
   * all-clear.
   */
  degraded?: { detail: string };
}

/** Typed result of a promote attempt. Fail-closed: `ok:false` carries why. */
export type PromoteResult =
  | { ok: true; mergedSha: string }
  | { ok: false; reason: string };

/**
 * Injectable collaborators so the lib is unit-testable with no network and a
 * frozen clock. Production wires `defaultGithubClient()` and `Date.now`.
 */
export interface ReleaseGateDeps {
  client?: GithubClient;
  /** Clock - returns epoch ms. Injected so ageHours math is deterministic. */
  now?: () => number;
  /** GitHub org + repo. Defaults to the wolfpack-apex production repo. */
  owner?: string;
  repo?: string;
  /** Production branch PRs must target to count as blocking. Defaults to main. */
  productionBranch?: string;
}

const DEFAULT_OWNER = "the-wolfpack-agency";
const DEFAULT_REPO = "wolfpack-apex";
const DEFAULT_PRODUCTION_BRANCH = "main";

/**
 * Raw shape of an open PR + its merge/review/check signals as returned by the
 * GraphQL query below. Only the fields we map are typed.
 */
interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  baseRefName: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub's combined merge-state: BLOCKED, BEHIND, UNSTABLE, DIRTY, CLEAN, etc. */
  mergeStateStatus: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null (no required reviews). */
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  isDraft: boolean;
  author: { login: string } | null;
  headRefOid: string;
  /** Latest commit's rolled-up CI status. */
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: "SUCCESS" | "PENDING" | "FAILURE" | "ERROR" | "EXPECTED" } | null;
      };
    }>;
  };
}

const OPEN_PRS_QUERY = `
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        createdAt
        baseRefName
        mergeable
        mergeStateStatus
        reviewDecision
        isDraft
        author { login }
        headRefOid
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}`.trim();

const SINGLE_PR_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      title
      url
      createdAt
      baseRefName
      mergeable
      mergeStateStatus
      reviewDecision
      isDraft
      author { login }
      headRefOid
      commits(last: 1) {
        nodes { commit { statusCheckRollup { state } } }
      }
    }
  }
}`.trim();

/**
 * POST a GraphQL query through the injected client. Returns the typed `data`
 * payload, or throws so the caller can convert into an honest degrade / typed
 * failure. Never silently swallows: a non-2xx, a transport error, or a
 * GraphQL `errors` array all throw.
 */
async function graphql<T>(
  client: GithubClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  if (!client.token) {
    throw new Error("GITHUB_TOKEN_WOLFPACK_AGENCY not set - cannot reach GitHub");
  }
  const res = await client.fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${client.token}`,
      "Content-Type": "application/json",
      "User-Agent": "wolfpack-instinct-release-gate",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub GraphQL HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GitHub GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) {
    throw new Error("GitHub GraphQL returned no data");
  }
  return json.data;
}

/** Rolled-up CI status of a PR's latest commit, or null when no checks exist. */
function rollupState(pr: RawPullRequest): RawPullRequest["commits"]["nodes"][number]["commit"]["statusCheckRollup"] {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
}

/**
 * Derive the gate state + a PLAIN-LANGUAGE reason from a PR's raw GitHub
 * signals. The ordering is deliberate - we report the MOST actionable blocker
 * first so the operator fixes the right thing:
 *
 *   1. merge conflict   -> nothing else matters until it is resolved
 *   2. checks failing    -> the build is red; fixing it is the next step
 *   3. checks running     -> just wait
 *   4. awaiting approval   -> a human needs to review
 *   5. ready_to_merge       -> promotable
 *
 * The plain-language string is what a non-engineer operator reads in the UI;
 * it never echoes a GitHub enum.
 */
export function deriveState(pr: RawPullRequest): { state: ReleaseBlockState; reason: string } {
  // 1. Conflict beats everything: the branch cannot merge regardless of checks.
  //    `mergeable: CONFLICTING` is authoritative; `mergeStateStatus: DIRTY` is
  //    the same condition from the combined-status vocabulary.
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return { state: "merge_conflict", reason: "Has merge conflicts" };
  }

  // 2/3. Checks. The rollup is the single source of truth for CI state.
  const rollup = rollupState(pr);
  if (rollup) {
    if (rollup.state === "FAILURE" || rollup.state === "ERROR") {
      return { state: "checks_failing", reason: "Tests are failing - fix needed" };
    }
    if (rollup.state === "PENDING" || rollup.state === "EXPECTED") {
      return { state: "checks_running", reason: "Tests are still running" };
    }
  }

  // 4. Approval. After conflicts + checks, an unmet required review is the
  //    blocker. CHANGES_REQUESTED and REVIEW_REQUIRED both mean "needs a human".
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") {
    return { state: "awaiting_approval", reason: "Waiting on your approval" };
  }

  // 4b. mergeStateStatus BLOCKED with no conflict + green checks is almost
  //     always an unmet branch-protection requirement (e.g. required review).
  //     Treat it as awaiting approval rather than falsely advertising "ready".
  if (pr.mergeStateStatus === "BLOCKED") {
    return { state: "awaiting_approval", reason: "Waiting on your approval" };
  }

  // 5. Conflict-free, checks green (or none required), approved/no review
  //    needed -> promotable.
  return { state: "ready_to_merge", reason: "Ready to promote" };
}

/** Hours (with fractional precision) since `createdAtIso`, given `nowMs`. */
function ageHoursFrom(createdAtIso: string, nowMs: number): number {
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return 0;
  const ms = Math.max(0, nowMs - created);
  // Round to 1 decimal so "0.5h ago" reads cleanly; never a float blob.
  return Math.round((ms / 3_600_000) * 10) / 10;
}

/**
 * Read the production release gate: every OPEN PR whose base is the production
 * branch, classified into a state + plain-language reason, newest first.
 *
 * HONEST DEGRADE: any failure to reach/parse GitHub returns an EMPTY blocking
 * list WITH `degraded` set - never a clean all-clear gate.
 */
export async function getReleaseGate(deps: ReleaseGateDeps = {}): Promise<ReleaseGateStatus> {
  const client = deps.client ?? defaultGithubClient();
  const now = deps.now ?? Date.now;
  const owner = deps.owner ?? DEFAULT_OWNER;
  const repo = deps.repo ?? DEFAULT_REPO;
  const productionBranch = deps.productionBranch ?? DEFAULT_PRODUCTION_BRANCH;
  const checkedAt = new Date(now()).toISOString();

  let data: { repository: { pullRequests: { nodes: RawPullRequest[] } } | null };
  try {
    data = await graphql(client, OPEN_PRS_QUERY, { owner, repo });
  } catch (err) {
    // Honest degrade - we could NOT check, so we say so rather than implying
    // nothing is blocking production.
    return {
      productionBranch,
      blocking: [],
      checkedAt,
      degraded: { detail: `Could not reach GitHub to check the release gate: ${(err as Error).message}` },
    };
  }

  const repository = data.repository;
  if (!repository) {
    return {
      productionBranch,
      blocking: [],
      checkedAt,
      degraded: { detail: `GitHub returned no repository for ${owner}/${repo}.` },
    };
  }

  const nowMs = now();
  const blocking: BlockingChange[] = repository.pullRequests.nodes
    // Only PRs that would deploy to prod: base must be the production branch.
    // Drafts are explicitly excluded - a draft is not a candidate to promote.
    .filter((pr) => pr.baseRefName === productionBranch && !pr.isDraft)
    .map((pr) => {
      const { state, reason } = deriveState(pr);
      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login ?? "unknown",
        headSha: pr.headRefOid,
        state,
        reason,
        ageHours: ageHoursFrom(pr.createdAt, nowMs),
      };
    });

  return { productionBranch, blocking, checkedAt };
}

const PR_FILES_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      files(first: 100) { nodes { path } }
    }
  }
}`.trim();

/** The changed-file paths of one or more PRs, or an honest degrade. */
export interface ChangedFilesResult {
  filesByPr: Record<number, string[]>;
  /**
   * Present IFF we could not fetch the file lists. Callers feed this into the
   * merge planner so the UI flags the overlap analysis as incomplete - never a
   * false "no conflicts."
   */
  degraded?: { detail: string };
}

/**
 * Fetch the changed-file paths for each PR number, used to predict which ready
 * changes will collide on merge (the merge-order planner consumes this). Reuses
 * the same injected GitHub client + GraphQL plumbing as the gate read; one query
 * per PR (the lists are small and the ready set is tiny in practice).
 *
 * HONEST DEGRADE: if any fetch fails we return whatever we gathered plus a
 * `degraded` detail, so the planner can say "overlap analysis incomplete" rather
 * than implying the changes are conflict-free.
 */
export async function fetchChangedFilesByPr(
  prNumbers: number[],
  deps: ReleaseGateDeps = {},
): Promise<ChangedFilesResult> {
  const client = deps.client ?? defaultGithubClient();
  const owner = deps.owner ?? DEFAULT_OWNER;
  const repo = deps.repo ?? DEFAULT_REPO;

  const filesByPr: Record<number, string[]> = {};
  for (const number of prNumbers) {
    let data: { repository: { pullRequest: { files: { nodes: Array<{ path: string }> } } | null } | null };
    try {
      data = await graphql(client, PR_FILES_QUERY, { owner, repo, number });
    } catch (err) {
      return {
        filesByPr,
        degraded: { detail: `Could not fetch changed files for #${number}: ${(err as Error).message}` },
      };
    }
    filesByPr[number] = data.repository?.pullRequest?.files?.nodes?.map((n) => n.path) ?? [];
  }
  return { filesByPr };
}

/**
 * Promote a change to production by merging its PR into the production branch.
 *
 * FAIL CLOSED: we re-fetch the PR fresh (never trust a stale list-time state),
 * recompute its gate state, and merge ONLY when it is `ready_to_merge`. Any
 * other state - awaiting approval, checks running, checks failing, conflict -
 * is refused with a typed, plain-language reason and NO merge call is made.
 *
 * On success we squash-merge (one clean commit on prod) and return the merged
 * commit SHA.
 */
export async function promoteChange(
  prNumber: number,
  deps: ReleaseGateDeps = {},
): Promise<PromoteResult> {
  const client = deps.client ?? defaultGithubClient();
  const owner = deps.owner ?? DEFAULT_OWNER;
  const repo = deps.repo ?? DEFAULT_REPO;
  const productionBranch = deps.productionBranch ?? DEFAULT_PRODUCTION_BRANCH;

  // 1. Re-fetch the PR fresh. A failure here is fail-closed: we refuse to
  //    promote on a state we could not verify.
  let data: { repository: { pullRequest: RawPullRequest | null } | null };
  try {
    data = await graphql(client, SINGLE_PR_QUERY, { owner, repo, number: prNumber });
  } catch (err) {
    return { ok: false, reason: `Could not verify the change before promoting: ${(err as Error).message}` };
  }

  const pr = data.repository?.pullRequest ?? null;
  if (!pr) {
    return { ok: false, reason: `Change #${prNumber} was not found.` };
  }
  if (pr.baseRefName !== productionBranch) {
    return {
      ok: false,
      reason: `Change #${prNumber} does not target the production branch (${productionBranch}); it targets ${pr.baseRefName}.`,
    };
  }
  if (pr.isDraft) {
    return { ok: false, reason: `Change #${prNumber} is still a draft and cannot be promoted.` };
  }

  // 2. Recompute the gate state. Only ready_to_merge is promotable.
  const { state, reason } = deriveState(pr);
  if (state !== "ready_to_merge") {
    return { ok: false, reason: `Not ready to promote: ${reason}.` };
  }

  // 3. Merge (squash) via REST. We pass the verified head SHA so GitHub rejects
  //    the merge if the branch advanced between verification and merge - a
  //    last-line fail-closed guard against a TOCTOU race.
  let res: Response;
  try {
    res = await client.fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "wolfpack-instinct-release-gate",
      },
      body: JSON.stringify({
        merge_method: "squash",
        sha: pr.headRefOid,
      }),
    });
  } catch (err) {
    return { ok: false, reason: `The merge call to GitHub failed: ${(err as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 405/409 = GitHub itself refused the merge (not mergeable / sha mismatch).
    // Surface it as a refusal, not a success - fail closed.
    return { ok: false, reason: `GitHub refused the merge (HTTP ${res.status}): ${body.slice(0, 200)}` };
  }

  const merged = (await res.json().catch(() => ({}))) as { sha?: string; merged?: boolean };
  if (!merged.merged || !merged.sha) {
    return { ok: false, reason: "GitHub reported the merge did not complete." };
  }

  return { ok: true, mergedSha: merged.sha };
}
