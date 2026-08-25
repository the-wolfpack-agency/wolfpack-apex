/**
 * recent_workflow_runs — intent + execution tests.
 */

const mockRecentRuns = jest.fn();
const mockTrackEvent = jest.fn();
jest.mock("@/lib/assistant/tools/github-query-client", () => ({
  recentWorkflowRuns: (...a: any[]) => mockRecentRuns(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { recentWorkflowRunsTool } from "@/lib/assistant/tools/recent-workflow-runs-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
});

describe("matchIntent — basic phrases", () => {
  test("'recent workflow runs in wolfpack-apex' → repo only", () => {
    const p = recentWorkflowRunsTool.matchIntent("recent workflow runs in wolfpack-apex");
    expect(p?.repo).toBe("wolfpack-apex");
    expect(p?.status).toBeUndefined();
  });

  test("'show me failed CI runs in wolfpack-auto' → status=failure", () => {
    const p = recentWorkflowRunsTool.matchIntent("show me failed CI runs in wolfpack-auto");
    expect(p?.repo).toBe("wolfpack-auto");
    expect(p?.status).toBe("failure");
  });

  test("'is the build green for wolfpack-apex' → status=success", () => {
    const p = recentWorkflowRunsTool.matchIntent("is the build green for wolfpack-apex");
    expect(p?.repo).toBe("wolfpack-apex");
    expect(p?.status).toBe("success");
  });

  test("'what is running in wolfpack-apex actions' → in_progress", () => {
    const p = recentWorkflowRunsTool.matchIntent("what is running in wolfpack-apex actions");
    expect(p?.repo).toBe("wolfpack-apex");
    expect(p?.status).toBe("in_progress");
  });
});

describe("matchIntent — rejection", () => {
  /* WAS: no repo → null, "we don't fan-out across the org".
     That invariant still holds and is asserted below: without a repo this
     tool never calls GitHub. What changed is what happens instead. Returning
     null sent "is CI green" to a model, which could not know the answer
     either and charged for the privilege. It now claims the phrase and asks
     which repository, which fans out across nothing. */
  test("no repo → claimed, but nothing is queried", () => {
    const p = recentWorkflowRunsTool.matchIntent("any failed workflow runs");
    expect(p).not.toBeNull();
    expect(p?.repo).toBeUndefined();
  });

  test.each([
    "open PRs in wolfpack-apex",
    "deals over $50k",
    "how many issues",
  ])("'%s' → null", (msg) => {
    expect(recentWorkflowRunsTool.matchIntent(msg)).toBeNull();
  });
});

describe("handler — success rendering", () => {
  test("renders run name, branch, event, actor + status emoji", async () => {
    mockRecentRuns.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          id: 1, name: "CI", status: "completed", conclusion: "success",
          event: "push", head_branch: "main", actor: "nhomyk",
          html_url: "https://github.com/x/y/actions/runs/1",
          created_at: "2026-05-15", updated_at: "2026-05-16",
        },
        {
          id: 2, name: "Deploy", status: "completed", conclusion: "failure",
          event: "workflow_dispatch", head_branch: "feature/x", actor: "alice",
          html_url: "https://github.com/x/y/actions/runs/2",
          created_at: "2026-05-14", updated_at: "2026-05-15",
        },
      ],
      durationMs: 90,
    });
    const r = await recentWorkflowRunsTool.handler(
      { repo: "wolfpack-apex" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toContain("Recent 2 workflow runs");
      expect(r.answer).toContain("✅");
      expect(r.answer).toContain("❌");
      expect(r.answer).toContain("`main`");
      expect(r.answer).toContain("push");
      /* Run name clicks out to the run page on github.com (logs +
       * re-run button). */
      expect(r.answer).toContain("[**CI**](https://github.com/x/y/actions/runs/1)");
      expect(r.answer).toContain(
        "[**Deploy**](https://github.com/x/y/actions/runs/2)",
      );
      expect(r.data.connector).toBe("github");
      expect(r.data.repo).toBe("wolfpack-apex");
    }
  });

  test("in_progress run renders ⏳", async () => {
    mockRecentRuns.mockResolvedValueOnce({
      ok: true,
      data: [{
        id: 9, name: "CI", status: "in_progress", conclusion: null,
        event: "push", head_branch: "main", actor: "alice",
        html_url: "https://github.com/x/y/actions/runs/9",
        created_at: "2026-05-16", updated_at: "2026-05-16",
      }],
      durationMs: 30,
    });
    const r = await recentWorkflowRunsTool.handler(
      { repo: "wolfpack-apex", status: "in_progress" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("⏳");
  });

  test("0 results → no-matches message", async () => {
    mockRecentRuns.mockResolvedValueOnce({
      ok: true, data: [], durationMs: 10,
    });
    const r = await recentWorkflowRunsTool.handler(
      { repo: "wolfpack-apex", status: "failure" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("No workflow runs");
    expect(r.answer).toContain("failure");
  });
});

describe("handler — failure paths", () => {
  test("auth_failed → capability", async () => {
    mockRecentRuns.mockResolvedValueOnce({
      ok: false, code: "auth_failed", message: "401",
    });
    const r = await recentWorkflowRunsTool.handler({ repo: "wolfpack-apex" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("capability");
  });

  test("not_found → internal", async () => {
    mockRecentRuns.mockResolvedValueOnce({
      ok: false, code: "not_found", message: "404",
    });
    const r = await recentWorkflowRunsTool.handler({ repo: "missing" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });
});

/* ---------------------------------------------------------------------
 * Found by scripts/phrase-sweep.ts: nobody names a repo when they ask whether
 * the build is alright.
 *
 * The tool returned null without one, so "is CI green" and "are the tests
 * passing" reached a model, and "did the build pass" was answered by the
 * Vercel deployments widget - a list of deploys in reply to a question about
 * CI. It is registered at 44 and this tool at 37, so simply claiming the
 * phrase is enough to take it back.
 * --------------------------------------------------------------- */
describe("asking about the build without naming a repo", () => {
  const match = (m: string) => recentWorkflowRunsTool.matchIntent!(m);

  it.each([
    "is CI green",
    "are the tests passing",
    "did the build pass",
    "show me recent workflow runs",
  ])("%s is a question about the build", (m) => {
    expect(match(m)).not.toBeNull();
  });

  it("leaves the repo unset rather than inventing one", () => {
    /* "green" is still read as a status filter; the point is that no repo is
       conjured to go with it. */
    expect(match("is CI green")).toEqual({ status: "success" });
  });

  it("still reads an explicit repo when there is one", () => {
    expect(match("is the build green for wolfpack-apex")).toEqual({
      repo: "wolfpack-apex",
      status: "success",
    });
  });

  /* THE SECOND JOB THE REPO REQUIREMENT WAS DOING, and the thing that would
     have made dropping it a bug. The keyword gate accepts the bare word
     "build", so without a repo to lean on, anything about building something
     would land here. Asking about a build's RESULT is a different sentence
     from asking somebody to build something. */
  it.each([
    "can you build a landing page",
    "we need to build trust with the client",
    "I tested the new flow and it feels slow",
  ])("%s is not a question about CI", (m) => {
    expect(match(m)).toBeNull();
  });
});

describe("when no repo is named, it asks instead of guessing", () => {
  it("returns a question and no runs, without calling GitHub", async () => {
    const res = await recentWorkflowRunsTool.handler({} as never, {
      userId: "u1",
      userRole: "cto",
      workspaceId: "w1",
    } as never);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.answer).toMatch(/which repositor/i);
    expect(res.data.runs).toHaveLength(0);
    /* Naming a repo it was never told about would be the failure this
       replaces, not a fix for it. */
    expect(res.data.repo).toBe("");
  });
});

/* ---------------------------------------------------------------------
 * A prose list of repositories is a list of things to retype, and retyping is
 * where people give up: the whole reason the tool asked is that it could not
 * work the answer out, so making them spell it back is a poor trade.
 * --------------------------------------------------------------- */
describe("asking which repository, as buttons", () => {
  const run = async (repos: string[]) => {
    const mod = await import("@/lib/assistant/tools/github-repos");
    const spy = jest.spyOn(mod, "knownRepos").mockResolvedValue(repos);
    const res = await recentWorkflowRunsTool.handler({} as never, {
      userId: "u1",
      userRole: "cto",
      workspaceId: "w1",
      message: "is CI green",
    } as never);
    spy.mockRestore();
    return res;
  };

  it("offers one tap per repository", async () => {
    const res = await run(["wolfpack-apex", "wolfpack-auto"]);
    if (!res.ok) throw new Error("expected ok");
    expect(res.widget?.kind).toBe("clarify");
    const spec = res.widget as { suggestions: Array<{ label: string; query: string }> };
    expect(spec.suggestions.map((s) => s.label)).toEqual([
      "wolfpack-apex",
      "wolfpack-auto",
    ]);
  });

  /* THE BUTTON HAS TO RUN. A chip that re-sends a sentence this tool cannot
     match would be a picker that looks like it works and does not. */
  it("each button re-sends a question this tool can answer", async () => {
    const res = await run(["wolfpack-apex"]);
    if (!res.ok) throw new Error("expected ok");
    const spec = res.widget as { suggestions: Array<{ query: string }> };
    for (const s of spec.suggestions) {
      const params = recentWorkflowRunsTool.matchIntent!(s.query) as {
        repo?: string;
      } | null;
      expect(params).not.toBeNull();
      expect(params?.repo).toBe("wolfpack-apex");
    }
  });

  /* It does not tell somebody what they typed. They did not mistype; they
     asked a fair question that named no repository. */
  it("frames it as a question rather than a correction", async () => {
    const res = await run(["wolfpack-apex"]);
    if (!res.ok) throw new Error("expected ok");
    expect((res.widget as { subtitle?: string }).subtitle).toBe("Pick one and I will run it.");
  });

  /* Nothing to offer is not a picker, and an empty box is worse than a
     sentence naming the shape of the thing to type. */
  it("falls back to words when there is nothing to offer", async () => {
    const res = await run([]);
    if (!res.ok) throw new Error("expected ok");
    expect(res.widget).toBeUndefined();
    expect(res.answer).toMatch(/which repositor/i);
  });
});

/* ---------------------------------------------------------------------
 * Found by reading the answer, not the code. scripts/prompt-transcript.ts
 * showed the picker offering seven scratch repos ahead of the real one:
 * wolfpack-test10, test11, test12, test2, test3, test4, test6.
 *
 * The query was correct and the tool worked. The reply was a menu of junk,
 * which no assertion about tools or matchers could have caught.
 * --------------------------------------------------------------- */
describe("the repositories it offers", () => {
  it("asks for ready sites, most recently touched first", async () => {
    const db = await import("@/lib/db");
    const spy = jest
      .spyOn(db, "safeQuery")
      .mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test";

    const { knownRepos } = await import("@/lib/assistant/tools/github-repos");
    await knownRepos();

    const sql = String(spy.mock.calls[0]?.[0] ?? "");
    /* A site that failed to deploy is not one to ask about the build of. */
    expect(sql).toMatch(/status\s*=\s*'ready'/);
    /* Alphabetical order is what surfaced the scratch repos. */
    expect(sql).toMatch(/ORDER BY\s+max\(updated_at\)\s+DESC/i);
    expect(sql).not.toMatch(/ORDER BY github_repo/i);

    process.env.DATABASE_URL = prev;
    spy.mockRestore();
  });
});
