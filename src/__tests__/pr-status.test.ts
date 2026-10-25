/**
 * npm run pr:status: the CI rollup and the ready / waiting / blocked grouping.
 * Fixtures are shaped like the Checks API, Statuses API and pulls API rows.
 */
import {
  DEPLOYS_PRODUCTION_ON_MERGE,
  classify,
  humanAge,
  parsePrStatusArgs,
  renderText,
  rollupChecks,
  searchQuery,
  type CheckRunRow,
  type PrInfo,
} from "../../scripts/lib/pr-status";

const NOW = new Date("2026-10-24T12:00:00Z");
const run = (id: number, name: string, status: string, conclusion: string | null): CheckRunRow => ({ id, name, status, conclusion });

const GREEN = rollupChecks([run(1, "verify", "completed", "success"), run(2, "lint", "completed", "success"), run(3, "deploy-preview", "completed", "skipped")], []);

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    repo: "wolfpack-apex",
    number: 1,
    url: "https://github.com/the-wolfpack-agency/wolfpack-apex/pull/1",
    title: "t",
    createdAt: "2026-10-23T12:00:00Z",
    draft: false,
    mergeable: true,
    mergeableState: "clean",
    ci: GREEN,
    ...over,
  };
}

describe("rollupChecks", () => {
  it("counts pass, fail, pending and skipped, and names the failing checks", () => {
    const r = rollupChecks(
      [
        run(1, "verify", "completed", "success"),
        run(2, "e2e", "completed", "failure"),
        run(3, "codeql", "in_progress", null),
        run(4, "optional", "completed", "skipped"),
        run(5, "lint", "completed", "neutral"),
        run(6, "timeout", "completed", "timed_out"),
      ],
      [
        { id: 10, context: "Vercel", state: "pending" },
        { id: 11, context: "legacy-ci", state: "error" },
      ],
    );
    expect(r).toEqual({ pass: 2, fail: 3, pending: 2, skipped: 1, failing: ["e2e", "legacy-ci", "timeout"], pendingNames: ["Vercel", "codeql"] });
  });

  it("keeps only the latest run per check name, so a fixed re-run is not counted as failing", () => {
    const r = rollupChecks([run(1, "verify", "completed", "failure"), run(9, "verify", "completed", "success")], [
      { id: 1, context: "Vercel", state: "pending" },
      { id: 2, context: "Vercel", state: "success" },
    ]);
    expect(r).toMatchObject({ pass: 2, fail: 0, pending: 0 });
  });

  it("is empty for a commit with no checks", () => {
    expect(rollupChecks([], [])).toEqual({ pass: 0, fail: 0, pending: 0, skipped: 0, failing: [], pendingNames: [] });
  });
});

describe("classify", () => {
  it("ready: every check passed or skipped, mergeable", () => {
    const c = classify(pr(), NOW);
    expect(c.group).toBe("ready");
    expect(c.reasons).toEqual([]);
    expect(classify(pr({ mergeableState: "unstable" }), NOW).group).toBe("ready");
  });

  it("waiting: a check still running, or mergeability not computed yet", () => {
    const pending = rollupChecks([run(1, "verify", "completed", "success"), run(2, "e2e", "queued", null)], []);
    expect(classify(pr({ ci: pending }), NOW)).toMatchObject({ group: "waiting", reasons: ["pending: e2e"] });
    expect(classify(pr({ mergeable: null, mergeableState: "unknown" }), NOW).group).toBe("waiting");
  });

  it("blocked: failing check (named), conflict, draft, or unmet branch protection", () => {
    const failing = rollupChecks([run(1, "verify", "completed", "failure"), run(2, "e2e", "in_progress", null)], []);
    expect(classify(pr({ ci: failing }), NOW)).toMatchObject({ group: "blocked", reasons: ["failing: verify"] });
    expect(classify(pr({ mergeable: false, mergeableState: "dirty" }), NOW).reasons).toEqual(["merge conflict"]);
    expect(classify(pr({ draft: true, mergeableState: "draft" }), NOW).reasons).toEqual(["draft"]);
    expect(classify(pr({ mergeableState: "blocked" }), NOW).reasons[0]).toMatch(/branch protection/);
  });

  it("flags repositories that deploy production on merge, from one list", () => {
    expect(DEPLOYS_PRODUCTION_ON_MERGE).toEqual(["wolfpack-weekend", "OGIAM", "wolfpack-aidan-mulready", "wolfpack-feed", "wolfpack-apex"]);
    expect(classify(pr({ repo: "OGIAM" }), NOW).deploysProduction).toBe(true);
    expect(classify(pr({ repo: "wolfpack-lms" }), NOW).deploysProduction).toBe(false);
  });

  it("computes age", () => {
    expect(classify(pr({ createdAt: "2026-10-20T11:00:00Z" }), NOW).ageDays).toBe(4);
    expect(humanAge("2026-10-24T11:30:00Z", NOW)).toBe("30m");
    expect(humanAge("2026-10-23T12:00:00Z", NOW)).toBe("24h");
    expect(humanAge("2026-10-01T12:00:00Z", NOW)).toBe("23d");
  });
});

describe("renderText", () => {
  it("prints the three groups with full URLs, CI counts and the deploy marker", () => {
    const failing = rollupChecks([run(1, "verify", "completed", "failure")], []);
    const out = renderText(
      [classify(pr(), NOW), classify(pr({ repo: "wolfpack-lms", url: "https://github.com/the-wolfpack-agency/wolfpack-lms/pull/9", ci: failing }), NOW)],
      NOW,
    );
    expect(out).toContain("## Ready to merge (1)");
    expect(out).toContain("## Waiting on CI (0)\n\n- none");
    expect(out).toContain("## Blocked (1)");
    expect(out).toContain("https://github.com/the-wolfpack-agency/wolfpack-apex/pull/1");
    expect(out).toContain("CI pass 2, fail 0, pending 0, skipped 1 | mergeable yes (clean) | deploys production on merge");
    expect(out).toContain("failing: verify");
  });
});

describe("arguments and query", () => {
  it("parses --since and --json, rejects bad input", () => {
    expect(parsePrStatusArgs([])).toEqual({ since: null, json: false });
    expect(parsePrStatusArgs(["--since", "2026-10-20", "--json"])).toEqual({ since: "2026-10-20", json: true });
    expect(parsePrStatusArgs(["--since", "last week"])).toHaveProperty("error");
    expect(parsePrStatusArgs(["--since"])).toHaveProperty("error");
    expect(parsePrStatusArgs(["--all"])).toHaveProperty("error");
  });

  it("searches open PRs by @me in the org, with an optional created date floor", () => {
    expect(searchQuery("the-wolfpack-agency", null)).toBe("is:pr is:open author:@me org:the-wolfpack-agency");
    expect(searchQuery("the-wolfpack-agency", "2026-10-20")).toBe("is:pr is:open author:@me org:the-wolfpack-agency created:>=2026-10-20");
  });
});
