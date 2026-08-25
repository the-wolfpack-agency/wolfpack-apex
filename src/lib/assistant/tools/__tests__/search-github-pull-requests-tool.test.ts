/**
 * search_github_pull_requests — intent + execution tests.
 */

const mockSearchPRs = jest.fn();
const mockTrackEvent = jest.fn();
jest.mock("@/lib/assistant/tools/github-query-client", () => ({
  searchPullRequests: (...a: any[]) => mockSearchPRs(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { searchGithubPullRequestsTool } from "@/lib/assistant/tools/search-github-pull-requests-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("matchIntent — state defaults", () => {
  test("'what PRs are open' → state=open, no repo, no author", () => {
    const p = searchGithubPullRequestsTool.matchIntent("what PRs are open");
    expect(p).not.toBeNull();
    expect(p?.state).toBe("open");
    expect(p?.repo).toBeUndefined();
    expect(p?.author).toBeUndefined();
  });

  test("'open pull requests' → state=open", () => {
    const p = searchGithubPullRequestsTool.matchIntent("open pull requests");
    expect(p?.state).toBe("open");
  });

  test("'closed PRs' → state=closed", () => {
    const p = searchGithubPullRequestsTool.matchIntent("closed PRs");
    expect(p?.state).toBe("closed");
  });

  test("'show me PRs' (no qualifier) defaults to open", () => {
    const p = searchGithubPullRequestsTool.matchIntent("show me PRs");
    expect(p?.state).toBe("open");
  });
});

describe("matchIntent — repo + author capture", () => {
  test("'PRs in wolfpack-apex' captures repo", () => {
    const p = searchGithubPullRequestsTool.matchIntent("PRs in wolfpack-apex");
    expect(p?.repo).toBe("wolfpack-apex");
  });

  test("'open PRs in wolfpack-auto by nhomyk' captures all 3 filters", () => {
    const p = searchGithubPullRequestsTool.matchIntent("open PRs in wolfpack-auto by nhomyk");
    expect(p?.state).toBe("open");
    expect(p?.repo).toBe("wolfpack-auto");
    expect(p?.author).toBe("nhomyk");
  });

  test("'PRs by @nhomyk' strips @", () => {
    const p = searchGithubPullRequestsTool.matchIntent("PRs by @nhomyk");
    expect(p?.author).toBe("nhomyk");
  });

  test("'closed pull requests in the-wolfpack-agency/wolfpack-apex' supports owner/name", () => {
    const p = searchGithubPullRequestsTool.matchIntent(
      "closed pull requests in the-wolfpack-agency/wolfpack-apex",
    );
    expect(p?.repo).toBe("the-wolfpack-agency/wolfpack-apex");
    expect(p?.state).toBe("closed");
  });
});

describe("matchIntent — rejection", () => {
  test.each([
    "how many deals",
    "find Grimace",
    "what meetings do I have on Monday",
    "look up contact id 003abc",
  ])("'%s' → null", (msg) => {
    expect(searchGithubPullRequestsTool.matchIntent(msg)).toBeNull();
  });
});

describe("handler — success rendering", () => {
  test("renders numbered list with repo#number, title, author, draft tag", async () => {
    mockSearchPRs.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 42, title: "feat: shiny widget", state: "open", draft: false,
          user: "nhomyk", repo: "the-wolfpack-agency/wolfpack-apex",
          html_url: "https://github.com/x/y/pull/42",
          created_at: "2026-05-15", updated_at: "2026-05-16",
        },
        {
          number: 43, title: "WIP: thing", state: "open", draft: true,
          user: "alice", repo: "the-wolfpack-agency/wolfpack-apex",
          html_url: "https://github.com/x/y/pull/43",
          created_at: "2026-05-14", updated_at: "2026-05-15",
        },
      ],
      durationMs: 120,
    });
    const r = await searchGithubPullRequestsTool.handler(
      { state: "open" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toContain("Found 2 open pull requests");
      expect(r.answer).toContain("wolfpack-apex#42");
      expect(r.answer).toContain("feat: shiny widget");
      expect(r.answer).toContain("@nhomyk");
      expect(r.answer).toContain("🚧"); // draft tag on PR 43
      /* Identifier links out to the PR on github.com so a click in
       * chat lands on the PR page, not a dead-text identifier. */
      expect(r.answer).toContain(
        "[the-wolfpack-agency/wolfpack-apex#42](https://github.com/x/y/pull/42)",
      );
      expect(r.answer).toContain(
        "[the-wolfpack-agency/wolfpack-apex#43](https://github.com/x/y/pull/43)",
      );
      /* Connector attribution flows through the data block so the chat
         UI can render the badge. */
      expect(r.data.connector).toBe("github");
    }
  });

  test("0 results → no-matches message", async () => {
    mockSearchPRs.mockResolvedValueOnce({
      ok: true, data: [], durationMs: 30,
    });
    const r = await searchGithubPullRequestsTool.handler(
      { state: "open", repo: "wolfpack-apex" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("No open pull requests");
    expect(r.answer).toContain("`wolfpack-apex`");
  });
});

describe("handler — failure paths", () => {
  test("auth_failed → tool capability failure", async () => {
    mockSearchPRs.mockResolvedValueOnce({
      ok: false, code: "auth_failed", message: "PAT missing",
    });
    const r = await searchGithubPullRequestsTool.handler(
      { state: "open" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("capability");
  });

  test("rate_limited → internal failure", async () => {
    mockSearchPRs.mockResolvedValueOnce({
      ok: false, code: "rate_limited", message: "rate limit hit",
    });
    const r = await searchGithubPullRequestsTool.handler(
      { state: "open" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });
});

describe("handler — analytics", () => {
  test("fires github_query_executed on success", async () => {
    mockSearchPRs.mockResolvedValueOnce({
      ok: true, data: [], durationMs: 50,
    });
    await searchGithubPullRequestsTool.handler(
      { state: "open", repo: "wolfpack-apex" },
      ctx,
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.github_query_executed",
      "u1", "cto",
      expect.objectContaining({
        tool: "search_github_pull_requests",
        ok: true,
        match_count: 0,
        repo: "wolfpack-apex",
      }),
    );
  });

  test("fires github_query_executed with ok=false on failure", async () => {
    mockSearchPRs.mockResolvedValueOnce({
      ok: false, code: "auth_failed", message: "401",
    });
    await searchGithubPullRequestsTool.handler({ state: "open" }, ctx);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.github_query_executed",
      "u1", "cto",
      expect.objectContaining({ ok: false, code: "auth_failed" }),
    );
  });
});

/* ---------------------------------------------------------------------
 * "What is waiting for review" is the commonest way to ask what needs
 * looking at, and it reached a model. Kept to fixed phrases rather than the
 * word "review", which belongs to performance, design and quarterly reviews.
 * --------------------------------------------------------------- */
describe("asking what needs reviewing", () => {
  const match = (m: string) => searchGithubPullRequestsTool.matchIntent!(m);

  it.each(["what is waiting for review", "anything awaiting review", "what needs review"])(
    "%s reaches the pull-request search",
    (m) => {
      expect(match(m)).not.toBeNull();
    },
  );

  it.each([
    "the quarterly review is next week",
    "I need a performance review with Sam",
  ])("%s is not a pull request", (m) => {
    expect(match(m)).toBeNull();
  });

  /* PR AS IN PUBLIC RELATIONS, which this agency does. The old guard tested
     for "press" AND the absence of a PR keyword, which the line above had
     already made impossible, so it did nothing and this claimed the tool. */
  it.each(["the PR firm sent their invoice", "the PR agency wants a call"])(
    "%s is public relations, not a pull request",
    (m) => {
      expect(match(m)).toBeNull();
    },
  );
});
