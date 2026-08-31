/**
 * The drain. These cover the states an operator never sees until something is
 * wrong: a deploy that reported no URL, a runner that threw, a queue with
 * nothing in it. Each one must end with a stored row saying what happened, and
 * none of them may end with a build recorded as accepted.
 */
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/platform-scan/ssrf-guard", () => ({ assertScannableUrl: jest.fn(async () => undefined) }));
// The mock mirrors the module's real exports. An incomplete module mock is the
// same failure as an incomplete fetch fake: the double stops modeling the
// thing it doubles, and the code is then tested against a fiction.
jest.mock("@/lib/spec-diff/browser", () => ({
  createSpecDiffBrowser: jest.fn(),
  specDiffBrowserSource: jest.fn(() => "local-launch"),
  BrowserUnavailableError: class BrowserUnavailableError extends Error {
    constructor(source: string, cause: unknown) {
      super(`no browser available (${source}): ${String(cause)}`);
      this.name = "BrowserUnavailableError";
    }
  },
}));
jest.mock("@/lib/spec-diff/run", () => ({ runSpecDiff: jest.fn() }));
jest.mock("@/lib/spec-diff/store", () => ({ saveSpecDiffRun: jest.fn() }));
jest.mock("../store", () => ({
  claimNextAcceptanceRun: jest.fn(),
  completeAcceptanceRun: jest.fn(async () => undefined),
  getAcceptanceCriteria: jest.fn(async () => null),
}));

import { drainAcceptanceQueue, executeAcceptanceRun, makeLayoutComparator } from "../service";
import { claimNextAcceptanceRun, completeAcceptanceRun, getAcceptanceCriteria } from "../store";
import { createSpecDiffBrowser } from "@/lib/spec-diff/browser";
import { runSpecDiff } from "@/lib/spec-diff/run";
import { saveSpecDiffRun } from "@/lib/spec-diff/store";
import { trackEvent } from "@/lib/analytics";
import { parseCriteria } from "../criteria";
import type { StoredAcceptanceRun } from "../store";

const run = (over: Partial<StoredAcceptanceRun> = {}): StoredAcceptanceRun & { workspace_id: string } =>
  ({
    id: "r1",
    workspace_id: "ws-1",
    project_id: "proj-1",
    deploy_id: "dep-1",
    deployed_url: "https://build.test",
    status: "running",
    verdict: null,
    spec_diff_run_id: null,
    attempts: 1,
    last_error: null,
    duration_ms: null,
    created_at: "",
    started_at: "",
    finished_at: null,
    ...over,
  }) as StoredAcceptanceRun & { workspace_id: string };

const okFetch = (async () => ({ status: 200, text: async () => "<h1>Acme</h1>" })) as unknown as typeof fetch;

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks clears calls, not implementations, so a mockResolvedValue set
  // by one test would otherwise decide the next one's verdict.
  (getAcceptanceCriteria as jest.Mock).mockResolvedValue(null);
  (completeAcceptanceRun as jest.Mock).mockResolvedValue(undefined);
});

describe("executeAcceptanceRun", () => {
  it("passes a healthy build and stores the verdict", async () => {
    const status = await executeAcceptanceRun(run(), () => ({ fetchImpl: okFetch }));
    expect(status).toBe("passed");
    expect(completeAcceptanceRun).toHaveBeenCalledWith("ws-1", "r1", expect.objectContaining({ status: "passed" }));
    expect(trackEvent).toHaveBeenCalledWith("site.acceptance_passed", "system", "system", expect.objectContaining({ project_id: "proj-1" }));
  });

  it("judges a project with no stored criteria against the defaults rather than skipping it", async () => {
    // A build nobody wrote criteria for must not also be a build nobody checked.
    (getAcceptanceCriteria as jest.Mock).mockResolvedValue(null);
    const status = await executeAcceptanceRun(run(), () => ({ fetchImpl: okFetch }));
    expect(status).toBe("passed");
  });

  it("degrades when the deploy reported no URL, because there was nothing to look at", async () => {
    const status = await executeAcceptanceRun(run({ deployed_url: null }), () => ({ fetchImpl: okFetch }));
    expect(status).toBe("degraded");
    expect(completeAcceptanceRun).toHaveBeenCalledWith("ws-1", "r1", expect.objectContaining({ status: "degraded", lastError: expect.stringMatching(/no URL/) }));
  });

  it("degrades, never passes, when the runner itself throws", async () => {
    const status = await executeAcceptanceRun(run(), () => ({
      fetchImpl: (() => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
      // A throw from inside runAcceptance's own plumbing, not a failed probe.
      assertPublicUrl: async () => {
        throw Object.assign(new Error("kaboom"), { name: "Unexpected" });
      },
    }));
    // An SSRF refusal is handled as unmeasured rather than thrown, so this
    // lands as degraded either way, which is the assertion that matters.
    expect(status).toBe("degraded");
    expect(completeAcceptanceRun).toHaveBeenCalledWith("ws-1", "r1", expect.objectContaining({ status: "degraded" }));
  });

  it("records a failing build as failed, with the failing checks named for the learning loop", async () => {
    (getAcceptanceCriteria as jest.Mock).mockResolvedValue({
      project_id: "proj-1",
      prototype_url: null,
      criteria: parseCriteria({ requiredContent: ["Wolfpack"] }),
      completeness: 0.4,
      updated_by: "u1",
      updated_at: "",
    });
    const status = await executeAcceptanceRun(run(), () => ({ fetchImpl: okFetch }));
    expect(status).toBe("failed");
    expect(trackEvent).toHaveBeenCalledWith(
      "site.acceptance_failed",
      "system",
      "system",
      expect.objectContaining({ failed_checks: "content", completeness: 0.4 }),
    );
  });
});

describe("drainAcceptanceQueue", () => {
  it("returns zeroes when nothing is waiting", async () => {
    (claimNextAcceptanceRun as jest.Mock).mockResolvedValue(null);
    expect(await drainAcceptanceQueue(3, () => ({ fetchImpl: okFetch }))).toEqual({ claimed: 0, passed: 0, failed: 0, degraded: 0, runIds: [] });
  });

  it("stops at the batch size even when more work is queued", async () => {
    (claimNextAcceptanceRun as jest.Mock).mockResolvedValue(run());
    const result = await drainAcceptanceQueue(2, () => ({ fetchImpl: okFetch }));
    expect(result.claimed).toBe(2);
    expect(claimNextAcceptanceRun).toHaveBeenCalledTimes(2);
  });

  it("counts each outcome separately, so a sweep reports what actually happened", async () => {
    (claimNextAcceptanceRun as jest.Mock)
      .mockResolvedValueOnce(run({ id: "a" }))
      .mockResolvedValueOnce(run({ id: "b", deployed_url: null }))
      .mockResolvedValueOnce(null);
    const result = await drainAcceptanceQueue(5, () => ({ fetchImpl: okFetch }));
    expect(result).toMatchObject({ claimed: 2, passed: 1, degraded: 1, failed: 0 });
  });
});

describe("makeLayoutComparator", () => {
  it("reports a browser that will not start instead of rejecting", async () => {
    (createSpecDiffBrowser as jest.Mock).mockRejectedValue(new Error("no chromium"));
    const out = await makeLayoutComparator("ws-1", null)({ prototypeUrl: "https://p.test", deployedUrl: "https://b.test", criteria: parseCriteria(null) });
    expect(out.error).toMatch(/browser unavailable/);
    expect(out.summary).toBeUndefined();
  });

  it("keeps the measurements when they cannot be filed", async () => {
    const summary = { totalDiffs: 0, totalMissing: 0, fontMismatch: false, matchedElements: 10, clean: true, worstOffenders: [] };
    (createSpecDiffBrowser as jest.Mock).mockResolvedValue({ browser: {}, hooks: {}, close: async () => undefined });
    (runSpecDiff as jest.Mock).mockResolvedValue({ summary, results: [], errors: [] });
    (saveSpecDiffRun as jest.Mock).mockRejectedValue(new Error("db down"));

    const out = await makeLayoutComparator("ws-1", null)({ prototypeUrl: "https://p.test", deployedUrl: "https://b.test", criteria: parseCriteria(null) });
    // A comparison that ran is not unmeasured just because the row did not save.
    expect(out.summary).toEqual(summary);
    expect(out.specDiffRunId).toBeNull();
  });

  it("always closes the browser, including when the comparison throws", async () => {
    const close = jest.fn(async () => undefined);
    (createSpecDiffBrowser as jest.Mock).mockResolvedValue({ browser: {}, hooks: {}, close });
    (runSpecDiff as jest.Mock).mockRejectedValue(new Error("navigation failed"));

    const out = await makeLayoutComparator("ws-1", null)({ prototypeUrl: "https://p.test", deployedUrl: "https://b.test", criteria: parseCriteria(null) });
    expect(out.error).toMatch(/navigation failed/);
    expect(close).toHaveBeenCalled();
  });
});
