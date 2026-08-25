/**
 * search_github_issues — intent + execution tests.
 */

const mockSearchIssues = jest.fn();
const mockTrackEvent = jest.fn();
jest.mock("@/lib/assistant/tools/github-query-client", () => ({
  searchIssues: (...a: any[]) => mockSearchIssues(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { searchGithubIssuesTool } from "@/lib/assistant/tools/search-github-issues-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("matchIntent — state", () => {
  test("'open issues in wolfpack-apex' → state=open, repo set", () => {
    const p = searchGithubIssuesTool.matchIntent("open issues in wolfpack-apex");
    expect(p?.state).toBe("open");
    expect(p?.repo).toBe("wolfpack-apex");
  });

  test("'closed issues in wolfpack-auto' → state=closed", () => {
    const p = searchGithubIssuesTool.matchIntent("closed issues in wolfpack-auto");
    expect(p?.state).toBe("closed");
  });

  test("'GitHub issues' bare → state defaults to open, no repo", () => {
    const p = searchGithubIssuesTool.matchIntent("any GitHub issues");
    expect(p?.state).toBe("open");
    expect(p?.repo).toBeUndefined();
  });
});

describe("matchIntent — label capture", () => {
  test("'issues labeled urgent in wolfpack-apex'", () => {
    const p = searchGithubIssuesTool.matchIntent("issues labeled urgent in wolfpack-apex");
    expect(p?.label).toBe("urgent");
    expect(p?.repo).toBe("wolfpack-apex");
  });

  test("'open bugs in wolfpack-auto' picks bug as label", () => {
    const p = searchGithubIssuesTool.matchIntent("open bugs in wolfpack-auto");
    expect(p?.label).toBe("bug");
    expect(p?.state).toBe("open");
  });
});

describe("matchIntent — author capture", () => {
  test("'closed github issues by @alice'", () => {
    const p = searchGithubIssuesTool.matchIntent("closed github issues by @alice");
    expect(p?.author).toBe("alice");
    expect(p?.state).toBe("closed");
  });
});

describe("matchIntent — rejection", () => {
  test.each([
    "pull requests in wolfpack-apex", // PR tool's job
    "open PRs",
    "deals over $50k",
    "what meetings do I have",
    "any issues with the deploy", // ambiguous, no GitHub anchor or repo
  ])("'%s' → null", (msg) => {
    expect(searchGithubIssuesTool.matchIntent(msg)).toBeNull();
  });
});

describe("handler — success rendering", () => {
  test("renders numbered list with repo#number, title, author, labels", async () => {
    mockSearchIssues.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          number: 17, title: "Login broken on iOS", state: "open",
          user: "alice", repo: "the-wolfpack-agency/wolfpack-apex",
          html_url: "https://github.com/x/y/issues/17",
          labels: ["bug", "mobile"],
          created_at: "2026-05-15", updated_at: "2026-05-16",
        },
      ],
      durationMs: 80,
    });
    const r = await searchGithubIssuesTool.handler(
      { state: "open", repo: "wolfpack-apex" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toContain("Found 1 open issue");
      expect(r.answer).toContain("wolfpack-apex#17");
      expect(r.answer).toContain("Login broken on iOS");
      expect(r.answer).toContain("@alice");
      expect(r.answer).toContain("[bug, mobile]");
      /* Identifier clicks out to the issue on github.com. */
      expect(r.answer).toContain(
        "[the-wolfpack-agency/wolfpack-apex#17](https://github.com/x/y/issues/17)",
      );
      expect(r.data.connector).toBe("github");
    }
  });

  test("0 results → no-matches message", async () => {
    mockSearchIssues.mockResolvedValueOnce({
      ok: true, data: [], durationMs: 20,
    });
    const r = await searchGithubIssuesTool.handler(
      { state: "open", repo: "wolfpack-apex", label: "bug" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("No open issues");
    expect(r.answer).toContain("`bug`");
  });
});

describe("handler — failure paths", () => {
  test("auth_failed → capability failure", async () => {
    mockSearchIssues.mockResolvedValueOnce({
      ok: false, code: "auth_failed", message: "401",
    });
    const r = await searchGithubIssuesTool.handler({ state: "open" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("capability");
  });

  test("not_found → internal failure", async () => {
    mockSearchIssues.mockResolvedValueOnce({
      ok: false, code: "not_found", message: "404",
    });
    const r = await searchGithubIssuesTool.handler(
      { state: "open", repo: "missing-repo" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });
});

/* ---------------------------------------------------------------------
 * Found by scripts/phrase-sweep.ts: the commonest ways to ask for the issue
 * list reached a model, which cannot see GitHub.
 *
 * The github/gh anchor kept them out. It exists to stop "any issues with the
 * deploy" and it is right to, so the additions are NARROWER than the anchor
 * rather than looser: a tracker-shaped noun phrase, not the word "issues".
 * --------------------------------------------------------------- */
describe("asking for the issue list in the words people use", () => {
  const match = (m: string) => searchGithubIssuesTool.matchIntent!(m);

  it.each(["any open issues", "what is on the backlog", "open issues for the repo"])(
    "%s reaches the issue search",
    (m) => {
      expect(match(m)).not.toBeNull();
    },
  );

  /* No repo named means the whole org, which is a real answer here and what
     the person asked for. "the repo" is not a repository called "repo". */
  it("asks the org rather than a repository named 'repo'", () => {
    expect(match("open issues for the repo")).toEqual({ state: "open" });
  });

  /* THE CHATTER THE ANCHOR EXISTS FOR. Still refused. */
  it.each(["any issues with the deploy", "we had issues with the client call"])(
    "%s is conversation, not a query",
    (m) => {
      expect(match(m)).toBeNull();
    },
  );

  /* NOT TAKEN, DELIBERATELY. This client filters by author, not assignee, and
     no Instinct user maps to a GitHub login. Claiming it would answer "what is
     assigned to me" with every open issue in the org - confidently and wrongly,
     which is worse than the model call it would replace. */
  it("refuses 'assigned to me', which it cannot answer correctly", () => {
    expect(match("what issues are assigned to me")).toBeNull();
  });
});
