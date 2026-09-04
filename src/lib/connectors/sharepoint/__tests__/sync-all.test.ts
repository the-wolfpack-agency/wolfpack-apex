/**
 * Estate-sync orchestrator tests. Injects the repo and a fake single-source
 * sync, so nothing here touches Graph, the DB, or the Brain. Validates the
 * guarantees that keep it safe:
 *   - Reuses per-source sync for every ACTIVE source the repo returns.
 *   - Fail-closed per source: one source throwing does not abort the rest.
 *   - Bounded per call: stops STARTING sources past the budget, reports
 *     moreRemaining so it can be resumed.
 *   - Aggregates counts and carries triggeredBy / role through unchanged.
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { syncAllSources } from "@/lib/connectors/sharepoint/sync-all";
import type { SharepointSource } from "@/lib/connectors/sharepoint/types";

function source(id: string, estate = "pcna"): SharepointSource {
  return {
    id, workspaceId: "ws1", name: `src-${id}`, siteUrl: "u", siteId: "S",
    driveId: `D-${id}`, folderPath: "F", createdBy: "u1", createdAt: "now",
    lastSyncedAt: null, isActive: true, estate, audienceRoles: ["admin"],
  };
}

function okResult(over: Partial<Record<string, unknown>> = {}) {
  return {
    jobId: "j", status: "succeeded", fileCount: 2, successCount: 2,
    failCount: 0, bytesIngested: 10, error: null, ...over,
  } as any;
}

function repoWith(sources: SharepointSource[]) {
  return { listSources: jest.fn().mockResolvedValue(sources) } as any;
}

beforeEach(() => mockTrackEvent.mockClear());

describe("syncAllSources", () => {
  test("syncs every active source and aggregates counts", async () => {
    const repo = repoWith([source("a"), source("b")]);
    const syncOne = jest.fn().mockResolvedValue(okResult());

    const r = await syncAllSources("ws1", "u1", "admin", { repo, syncOne });

    expect(syncOne).toHaveBeenCalledTimes(2);
    // triggeredBy + role are threaded through unchanged.
    expect(syncOne).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "u1", "admin");
    expect(r.sourcesTotal).toBe(2);
    expect(r.sourcesSucceeded).toBe(2);
    expect(r.sourcesFailed).toBe(0);
    expect(r.filesIngested).toBe(4);
    expect(r.moreRemaining).toBe(false);
  });

  test("fail-closed: one source throwing does not abort the others", async () => {
    const repo = repoWith([source("a"), source("b"), source("c")]);
    const syncOne = jest
      .fn()
      .mockResolvedValueOnce(okResult())
      .mockRejectedValueOnce(new Error("token_expired"))
      .mockResolvedValueOnce(okResult());

    const r = await syncAllSources("ws1", "u1", "admin", { repo, syncOne });

    expect(syncOne).toHaveBeenCalledTimes(3); // did NOT stop at the failure
    expect(r.sourcesSucceeded).toBe(2);
    expect(r.sourcesFailed).toBe(1);
    const bad = r.sources.find((s) => s.status === "error");
    expect(bad?.error).toBe("token_expired");
    expect(r.moreRemaining).toBe(true); // the errored source is still outstanding
  });

  test("a source that returns status=failed counts as failed, not succeeded", async () => {
    const repo = repoWith([source("a")]);
    const syncOne = jest.fn().mockResolvedValue(okResult({ status: "failed", successCount: 0 }));
    const r = await syncAllSources("ws1", "u1", "admin", { repo, syncOne });
    expect(r.sourcesFailed).toBe(1);
    expect(r.sourcesSucceeded).toBe(0);
  });

  test("bounded: stops starting sources past the budget and reports moreRemaining", async () => {
    const repo = repoWith([source("a"), source("b"), source("c")]);
    // Clock jumps past the budget after the first source, so b and c never start.
    const times = [0, 0, 100, 100, 100];
    const now = () => times.shift() ?? 100;
    const syncOne = jest.fn().mockResolvedValue(okResult());

    const r = await syncAllSources("ws1", "u1", "admin", {
      repo, syncOne, budgetMs: 50, now,
    });

    expect(syncOne).toHaveBeenCalledTimes(1); // only "a" started
    expect(r.sourcesProcessed).toBe(1);
    expect(r.moreRemaining).toBe(true);
  });

  test("propagates a source's own moreRemaining (resumable big folder)", async () => {
    const repo = repoWith([source("a")]);
    const syncOne = jest.fn().mockResolvedValue(okResult({ moreRemaining: true, remainingCount: 40 }));
    const r = await syncAllSources("ws1", "u1", "admin", { repo, syncOne });
    expect(r.moreRemaining).toBe(true);
  });

  test("empty estate: no sources, clean zero result, still emits the summary event", async () => {
    const repo = repoWith([]);
    const syncOne = jest.fn();
    const r = await syncAllSources("ws1", "u1", "admin", { repo, syncOne });
    expect(syncOne).not.toHaveBeenCalled();
    expect(r.sourcesTotal).toBe(0);
    expect(r.moreRemaining).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "connectors.sharepoint.estate_sync_finished", "u1", "admin",
      expect.objectContaining({ sources_total: 0, files_ingested: 0 }),
    );
  });
});
