/**
 * Unit tests for the Production Release Gate lib.
 *
 * Proves the two non-negotiables and the state/reason mapping with a stubbed
 * GitHub client (no network) and a frozen clock:
 *
 *   - Each PR shape -> correct ReleaseBlockState + plain-language reason
 *     (conflict, checks failing, checks running, awaiting approval, ready).
 *   - ageHours math from createdAt against an injected now().
 *   - HONEST DEGRADE: a GitHub error/HTTP-failure -> degraded set, blocking
 *     EMPTY - never a clean all-clear.
 *   - FAIL CLOSED: promoteChange refuses a not-ready PR (no merge call) and
 *     merges a ready one (squash) returning the merged SHA.
 */

import {
  getReleaseGate,
  promoteChange,
  deriveState,
  type ReleaseGateDeps,
} from "@/lib/deploy/release-gate";
import type { GithubClient } from "@/lib/github-client";

const NOW = Date.parse("2026-06-29T12:00:00.000Z");
const now = () => NOW;

/** Build a raw PR node with sane ready-to-merge defaults; override per test. */
function pr(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    number: 101,
    title: "Add release gate",
    url: "https://github.com/the-wolfpack-agency/wolfpack-apex/pull/101",
    createdAt: "2026-06-29T10:00:00.000Z", // 2h before NOW
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    isDraft: false,
    author: { login: "nick" },
    headRefOid: "abc123sha",
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...overrides,
  };
}

/**
 * Fake GitHub client whose fetch returns canned GraphQL / REST responses keyed
 * off URL + method. Records every call so we can assert merge-was/was-not called.
 */
function fakeClient(handlers: {
  openPrs?: () => unknown;
  singlePr?: () => unknown;
  merge?: (sha?: string) => { status: number; body: unknown };
}): { client: GithubClient; calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body: parsed });

    if (url.endsWith("/graphql")) {
      const isSingle = typeof parsed?.query === "string" && /pullRequest\(number/.test(parsed.query);
      const data = isSingle ? handlers.singlePr?.() : handlers.openPrs?.();
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    if (/\/pulls\/\d+\/merge$/.test(url) && method === "PUT") {
      const r = handlers.merge?.(parsed?.sha) ?? { status: 200, body: { merged: true, sha: "mergedsha" } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return { client: { token: "test-token", fetch: fetchImpl }, calls };
}

function deps(client: GithubClient): ReleaseGateDeps {
  return { client, now, owner: "the-wolfpack-agency", repo: "wolfpack-apex", productionBranch: "main" };
}

describe("deriveState - state + plain-language reason mapping", () => {
  it("merge conflict (mergeable CONFLICTING) -> merge_conflict", () => {
    const r = deriveState(pr({ mergeable: "CONFLICTING" }) as never);
    expect(r.state).toBe("merge_conflict");
    expect(r.reason).toBe("Has merge conflicts");
  });

  it("merge conflict via mergeStateStatus DIRTY -> merge_conflict", () => {
    const r = deriveState(pr({ mergeStateStatus: "DIRTY" }) as never);
    expect(r.state).toBe("merge_conflict");
  });

  it("conflict beats failing checks (conflict reported first)", () => {
    const r = deriveState(
      pr({ mergeable: "CONFLICTING", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } }) as never,
    );
    expect(r.state).toBe("merge_conflict");
  });

  it("checks FAILURE -> checks_failing", () => {
    const r = deriveState(pr({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } }) as never);
    expect(r.state).toBe("checks_failing");
    expect(r.reason).toBe("Tests are failing - fix needed");
  });

  it("checks ERROR -> checks_failing", () => {
    const r = deriveState(pr({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "ERROR" } } }] } }) as never);
    expect(r.state).toBe("checks_failing");
  });

  it("checks PENDING -> checks_running", () => {
    const r = deriveState(pr({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } }) as never);
    expect(r.state).toBe("checks_running");
    expect(r.reason).toBe("Tests are still running");
  });

  it("review REVIEW_REQUIRED -> awaiting_approval", () => {
    const r = deriveState(pr({ reviewDecision: "REVIEW_REQUIRED" }) as never);
    expect(r.state).toBe("awaiting_approval");
    expect(r.reason).toBe("Waiting on your approval");
  });

  it("review CHANGES_REQUESTED -> awaiting_approval", () => {
    const r = deriveState(pr({ reviewDecision: "CHANGES_REQUESTED" }) as never);
    expect(r.state).toBe("awaiting_approval");
  });

  it("mergeStateStatus BLOCKED (green, no conflict) -> awaiting_approval, not ready", () => {
    const r = deriveState(pr({ reviewDecision: null, mergeStateStatus: "BLOCKED" }) as never);
    expect(r.state).toBe("awaiting_approval");
  });

  it("clean + approved + green -> ready_to_merge", () => {
    const r = deriveState(pr() as never);
    expect(r.state).toBe("ready_to_merge");
    expect(r.reason).toBe("Ready to promote");
  });

  it("no required reviews (reviewDecision null) + green + clean -> ready_to_merge", () => {
    const r = deriveState(pr({ reviewDecision: null }) as never);
    expect(r.state).toBe("ready_to_merge");
  });
});

describe("getReleaseGate", () => {
  it("lists only open PRs targeting the production branch, excludes drafts + non-prod bases", async () => {
    const { client } = fakeClient({
      openPrs: () => ({
        repository: {
          pullRequests: {
            nodes: [
              pr({ number: 1, baseRefName: "main", reviewDecision: "REVIEW_REQUIRED" }),
              pr({ number: 2, baseRefName: "develop" }), // wrong base - excluded
              pr({ number: 3, baseRefName: "main", isDraft: true }), // draft - excluded
              pr({ number: 4, baseRefName: "main" }), // ready
            ],
          },
        },
      }),
    });
    const gate = await getReleaseGate(deps(client));
    expect(gate.degraded).toBeUndefined();
    expect(gate.productionBranch).toBe("main");
    expect(gate.blocking.map((b) => b.number).sort()).toEqual([1, 4]);
    const one = gate.blocking.find((b) => b.number === 1)!;
    expect(one.state).toBe("awaiting_approval");
    expect(one.author).toBe("nick");
    expect(one.headSha).toBe("abc123sha");
  });

  it("computes ageHours from createdAt against the injected clock", async () => {
    const { client } = fakeClient({
      openPrs: () => ({
        repository: {
          pullRequests: {
            nodes: [pr({ number: 7, createdAt: "2026-06-29T10:30:00.000Z" })], // 1.5h before NOW
          },
        },
      }),
    });
    const gate = await getReleaseGate(deps(client));
    expect(gate.blocking[0].ageHours).toBeCloseTo(1.5, 5);
  });

  it("HONEST DEGRADE: GitHub HTTP error -> degraded set, blocking EMPTY (not all-clear)", async () => {
    const client: GithubClient = {
      token: "t",
      fetch: (async () => new Response("502 bad gateway", { status: 502 })) as unknown as typeof fetch,
    };
    const gate = await getReleaseGate(deps(client));
    expect(gate.blocking).toEqual([]);
    expect(gate.degraded).toBeDefined();
    expect(gate.degraded!.detail).toMatch(/could not reach github/i);
  });

  it("HONEST DEGRADE: GraphQL errors array -> degraded set", async () => {
    const client: GithubClient = {
      token: "t",
      fetch: (async () =>
        new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), { status: 200 })) as unknown as typeof fetch,
    };
    const gate = await getReleaseGate(deps(client));
    expect(gate.blocking).toEqual([]);
    expect(gate.degraded).toBeDefined();
    expect(gate.degraded!.detail).toMatch(/rate limited/i);
  });

  it("HONEST DEGRADE: missing token -> degraded, never silent all-clear", async () => {
    const client: GithubClient = {
      token: "",
      fetch: (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    };
    const gate = await getReleaseGate(deps(client));
    expect(gate.degraded).toBeDefined();
    expect(gate.blocking).toEqual([]);
  });

  it("HONEST DEGRADE: null repository -> degraded", async () => {
    const { client } = fakeClient({ openPrs: () => ({ repository: null }) });
    const gate = await getReleaseGate(deps(client));
    expect(gate.degraded).toBeDefined();
  });
});

describe("promoteChange - FAIL CLOSED", () => {
  it("refuses an awaiting-approval PR and NEVER calls merge", async () => {
    const { client, calls } = fakeClient({
      singlePr: () => ({ repository: { pullRequest: pr({ reviewDecision: "REVIEW_REQUIRED" }) } }),
    });
    const res = await promoteChange(101, deps(client));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/waiting on your approval/i);
    expect(calls.some((c) => /\/merge$/.test(c.url))).toBe(false);
  });

  it("refuses a checks-failing PR and never merges", async () => {
    const { client, calls } = fakeClient({
      singlePr: () => ({
        repository: { pullRequest: pr({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } }) },
      }),
    });
    const res = await promoteChange(101, deps(client));
    expect(res.ok).toBe(false);
    expect(calls.some((c) => /\/merge$/.test(c.url))).toBe(false);
  });

  it("refuses a conflicting PR and never merges", async () => {
    const { client, calls } = fakeClient({
      singlePr: () => ({ repository: { pullRequest: pr({ mergeable: "CONFLICTING" }) } }),
    });
    const res = await promoteChange(101, deps(client));
    expect(res.ok).toBe(false);
    expect(calls.some((c) => /\/merge$/.test(c.url))).toBe(false);
  });

  it("refuses a PR not targeting the production branch", async () => {
    const { client, calls } = fakeClient({
      singlePr: () => ({ repository: { pullRequest: pr({ baseRefName: "develop" }) } }),
    });
    const res = await promoteChange(101, deps(client));
    expect(res.ok).toBe(false);
    expect(calls.some((c) => /\/merge$/.test(c.url))).toBe(false);
  });

  it("fails closed when the PR cannot be re-fetched (no merge)", async () => {
    const client: GithubClient = {
      token: "t",
      fetch: (async (url: string) => {
        if (url.endsWith("/graphql")) return new Response("boom", { status: 500 });
        throw new Error("merge should not be called");
      }) as unknown as typeof fetch,
    };
    const res = await promoteChange(101, deps(client));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/could not verify/i);
  });

  it("fails closed when the PR is not found", async () => {
    const { client } = fakeClient({ singlePr: () => ({ repository: { pullRequest: null } }) });
    const res = await promoteChange(999, deps(client));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not found/i);
  });

  it("merges a ready PR (squash, verified head sha) and returns the merged sha", async () => {
    const { client, calls } = fakeClient({
      singlePr: () => ({ repository: { pullRequest: pr() } }),
      merge: (sha) => ({ status: 200, body: { merged: true, sha: `merged-${sha}` } }),
    });
    const res = await promoteChange(101, deps(client));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mergedSha).toBe("merged-abc123sha");
    const mergeCall = calls.find((c) => /\/merge$/.test(c.url))!;
    expect(mergeCall.method).toBe("PUT");
    expect((mergeCall.body as Record<string, unknown>).merge_method).toBe("squash");
    expect((mergeCall.body as Record<string, unknown>).sha).toBe("abc123sha");
  });

  it("fails closed when GitHub itself refuses the merge (409)", async () => {
    const { client } = fakeClient({
      singlePr: () => ({ repository: { pullRequest: pr() } }),
      merge: () => ({ status: 409, body: { message: "head changed" } }),
    });
    const res = await promoteChange(101, deps(client));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/refused the merge/i);
  });

  it("fails closed when GitHub reports merge not completed", async () => {
    const { client } = fakeClient({
      singlePr: () => ({ repository: { pullRequest: pr() } }),
      merge: () => ({ status: 200, body: { merged: false } }),
    });
    const res = await promoteChange(101, deps(client));
    expect(res.ok).toBe(false);
  });
});
