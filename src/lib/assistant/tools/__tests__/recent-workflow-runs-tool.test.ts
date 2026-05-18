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
  test("no repo → null (we don't fan-out across the org)", () => {
    expect(recentWorkflowRunsTool.matchIntent("any failed workflow runs")).toBeNull();
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
