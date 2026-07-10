/**
 * Deployment pipeline: the pure stage builder, the fleet orchestrator (with fake
 * readers so it is deterministic + honest-degrade), and the agent-linked report.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  buildPipeline,
  getDeploymentPipelines,
  getAgentDeploymentPipelines,
  STAGE_ORDER,
  type PipelineDeps,
} from "@/lib/deploy/pipeline";

describe("buildPipeline (pure)", () => {
  it("emits the six ordered stages", () => {
    const p = buildPipeline({
      id: "pr-1",
      title: "x",
      url: "u",
      author: "a",
      commitSha: "sha1",
      prNumber: 1,
      gateState: "checks_running",
    });
    expect(p.stages.map((s) => s.key)).toEqual(STAGE_ORDER);
  });

  it("in-flight checks_failing -> ci failed, downstream pending, overall failed", () => {
    const p = buildPipeline({
      id: "pr-2", title: "x", url: "u", author: "a", commitSha: "s", prNumber: 2,
      gateState: "checks_failing",
    });
    expect(p.stages.find((s) => s.key === "ci")!.status).toBe("failed");
    expect(p.stages.find((s) => s.key === "build")!.status).toBe("pending");
    expect(p.status).toBe("failed");
    expect(p.currentStage).toBe("ci");
  });

  it("in-flight merge_conflict -> ci passed, merge failed", () => {
    const p = buildPipeline({
      id: "pr-3", title: "x", url: "u", author: "a", commitSha: "s", prNumber: 3,
      gateState: "merge_conflict",
    });
    expect(p.stages.find((s) => s.key === "ci")!.status).toBe("passed");
    expect(p.stages.find((s) => s.key === "merge")!.status).toBe("failed");
    expect(p.status).toBe("failed");
  });

  it("deployed + live + healthy -> all through health, overall deployed", () => {
    const p = buildPipeline({
      id: "sha9", title: "ship it", url: "u", author: "dev", commitSha: "sha9", prNumber: null,
      deploy: { state: "READY", target: "production", isLive: true, health: "healthy" },
    });
    expect(p.stages.find((s) => s.key === "verify")!.status).toBe("passed");
    expect(p.stages.find((s) => s.key === "health")!.status).toBe("passed");
    expect(p.status).toBe("deployed");
    expect(p.live).toBe(true);
  });

  it("deployed build ERROR -> build failed, promote/verify skipped/pending", () => {
    const p = buildPipeline({
      id: "sha8", title: "x", url: "u", author: "d", commitSha: "sha8", prNumber: null,
      hasMigration: true,
      deploy: { state: "ERROR", target: "production", isLive: false, health: null },
    });
    const build = p.stages.find((s) => s.key === "build")!;
    expect(build.status).toBe("failed");
    expect(build.detail).toMatch(/migration/i); // migration risk surfaced
    expect(p.status).toBe("failed");
  });

  it("deployed READY but superseded -> verify skipped, health skipped, still deployed", () => {
    const p = buildPipeline({
      id: "sha7", title: "x", url: "u", author: "d", commitSha: "sha7", prNumber: null,
      deploy: { state: "READY", target: "production", isLive: false, health: null },
    });
    expect(p.stages.find((s) => s.key === "verify")!.status).toBe("skipped");
    expect(p.stages.find((s) => s.key === "health")!.status).toBe("skipped");
    expect(p.status).toBe("deployed");
  });

  it("building -> build running, overall in_progress", () => {
    const p = buildPipeline({
      id: "sha6", title: "x", url: "u", author: "d", commitSha: "sha6", prNumber: null,
      deploy: { state: "BUILDING", target: "production", isLive: false, health: null },
    });
    expect(p.stages.find((s) => s.key === "build")!.status).toBe("running");
    expect(p.status).toBe("in_progress");
    expect(p.currentStage).toBe("build");
  });
});

function fakeDeps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    releaseGate: async () => ({ productionBranch: "main", blocking: [], checkedAt: "t" }),
    listDeployments: async () => ({ ok: true, data: { deployments: [] } }),
    vercelConfigured: () => true,
    readiness: async () => ({ ok: true, checks: [] }),
    servingSha: () => "live-sha",
    regressionsSince: async () => [],
    ...over,
  };
}

function regressionRecord(over: Record<string, unknown> = {}) {
  return {
    id: "r1", agentId: "agt-x", baselineModel: "old", candidateModel: "new",
    baselineSuccessRate: 0.9, candidateSuccessRate: 0.5, delta: -0.4,
    baselineSamples: 20, candidateSamples: 20, verdict: "regressed", createdAt: "2026-07-10T01:00:00Z",
    ...over,
  };
}

describe("getDeploymentPipelines (fleet orchestrator)", () => {
  beforeEach(() => mockSafeQuery.mockReset());

  it("marks the deploy whose commit == serving sha as live + healthy", async () => {
    const deps = fakeDeps({
      listDeployments: async () => ({
        ok: true,
        data: {
          deployments: [
            { uid: "d1", name: "app", url: "app.vercel.app", state: "READY", target: "production", createdAt: 1, meta: { githubCommitSha: "live-sha", githubCommitMessage: "the live one" }, creator: { username: "nick" } },
            { uid: "d2", name: "app", url: "old.vercel.app", state: "READY", target: "production", createdAt: 0, meta: { githubCommitSha: "old-sha" }, creator: { username: "nick" } },
          ],
        },
      }),
    });
    const report = await getDeploymentPipelines({ deps });
    const live = report.pipelines.find((p) => p.commitSha === "live-sha")!;
    expect(live.live).toBe(true);
    expect(live.stages.find((s) => s.key === "health")!.status).toBe("passed");
    const old = report.pipelines.find((p) => p.commitSha === "old-sha")!;
    expect(old.live).toBe(false);
    expect(old.stages.find((s) => s.key === "verify")!.status).toBe("skipped");
    expect(report.degraded).toEqual([]);
  });

  it("degrades honestly (no false all-clear) when Vercel is not configured", async () => {
    const deps = fakeDeps({ vercelConfigured: () => false });
    const report = await getDeploymentPipelines({ deps });
    expect(report.degraded.some((d) => d.source === "vercel")).toBe(true);
  });

  it("adds in-flight PRs and dedupes any already deployed by head sha", async () => {
    const deps = fakeDeps({
      listDeployments: async () => ({
        ok: true,
        data: { deployments: [{ uid: "d1", name: "app", url: "a.vercel.app", state: "READY", target: "production", createdAt: 1, meta: { githubCommitSha: "sha-merged" }, creator: {} }] },
      }),
      releaseGate: async () => ({
        productionBranch: "main",
        checkedAt: "t",
        blocking: [
          { number: 10, title: "in flight", url: "u", author: "a", headSha: "sha-open", state: "checks_running", reason: "r", ageHours: 1 },
          { number: 11, title: "already deployed", url: "u", author: "a", headSha: "sha-merged", state: "ready_to_merge", reason: "r", ageHours: 1 },
        ],
      }),
    });
    const report = await getDeploymentPipelines({ deps });
    expect(report.pipelines.some((p) => p.prNumber === 10)).toBe(true);
    // PR 11's head sha already appears among deployments -> not double-listed.
    expect(report.pipelines.some((p) => p.prNumber === 11)).toBe(false);
  });

  it("surfaces a github degrade when the gate is degraded", async () => {
    const deps = fakeDeps({
      releaseGate: async () => ({ productionBranch: "main", blocking: [], checkedAt: "t", degraded: { detail: "GitHub 502" } }),
    });
    const report = await getDeploymentPipelines({ deps });
    expect(report.degraded.some((d) => d.source === "github")).toBe(true);
  });

  it("attaches agent-regression impact to the LIVE deploy (since it went live)", async () => {
    const deps = fakeDeps({
      listDeployments: async () => ({
        ok: true,
        data: {
          deployments: [
            { uid: "d1", name: "app", url: "a.vercel.app", state: "READY", target: "production", createdAt: 100, readyAt: 200, meta: { githubCommitSha: "live-sha" }, creator: { username: "n" } },
            { uid: "d2", name: "app", url: "b.vercel.app", state: "READY", target: "production", createdAt: 50, readyAt: 60, meta: { githubCommitSha: "old-sha" }, creator: { username: "n" } },
          ],
        },
      }),
      regressionsSince: async (ws, since) => {
        expect(ws).toBe("ws-1");
        expect(since).toBe(new Date(200).toISOString()); // the live deploy's readyAt
        return [regressionRecord()];
      },
    });
    const report = await getDeploymentPipelines({ deps, workspaceId: "ws-1" });
    const live = report.pipelines.find((p) => p.live)!;
    expect(live.agentImpact?.regressionCount).toBe(1);
    expect(live.agentImpact?.regressions[0].candidateModel).toBe("new");
    // Only the live deploy carries impact.
    const old = report.pipelines.find((p) => p.commitSha === "old-sha")!;
    expect(old.agentImpact).toBeUndefined();
  });

  it("omits impact when no workspace is given (no correlation without scope)", async () => {
    const deps = fakeDeps({
      listDeployments: async () => ({
        ok: true,
        data: { deployments: [{ uid: "d1", name: "app", url: "a.vercel.app", state: "READY", target: "production", createdAt: 1, readyAt: 2, meta: { githubCommitSha: "live-sha" }, creator: {} }] },
      }),
      regressionsSince: async () => [regressionRecord()],
    });
    const report = await getDeploymentPipelines({ deps }); // no workspaceId
    expect(report.pipelines.find((p) => p.live)!.agentImpact).toBeUndefined();
  });
});

describe("getAgentDeploymentPipelines (agent-linked)", () => {
  beforeEach(() => mockSafeQuery.mockReset());

  it("returns [] when the agent triaged nothing", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    const report = await getAgentDeploymentPipelines("agt-1", "ws-1", fakeDeps());
    expect(report.links).toEqual([]);
  });

  it("matches a triaged PR to its in-flight pipeline, and marks a vanished one resolved", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { pr: "42", state: "checks_failing", at: "2026-07-10T00:00:00Z" },
        { pr: "7", state: "awaiting_approval", at: "2026-07-09T00:00:00Z" },
      ],
    });
    const deps = fakeDeps({
      releaseGate: async () => ({
        productionBranch: "main",
        checkedAt: "t",
        blocking: [{ number: 42, title: "still open", url: "u", author: "a", headSha: "s42", state: "checks_failing", reason: "r", ageHours: 2 }],
      }),
    });
    const report = await getAgentDeploymentPipelines("agt-1", "ws-1", deps);
    const l42 = report.links.find((l) => l.prNumber === 42)!;
    expect(l42.pipeline).not.toBeNull();
    expect(l42.resolved).toBe(false);
    const l7 = report.links.find((l) => l.prNumber === 7)!;
    expect(l7.pipeline).toBeNull();
    expect(l7.resolved).toBe(true); // no longer blocking -> merged/closed since triage
  });
});
