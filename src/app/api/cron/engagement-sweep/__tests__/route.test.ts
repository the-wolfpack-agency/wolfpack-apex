/**
 * GET /api/cron/engagement-sweep - the autonomy heartbeat. Pins:
 *   - the cron bearer path runs the sweep without a session (no requireCapability)
 *   - the response aggregates assessed / total / criticals across results
 *   - no bearer + denied capability -> the guard's 403, sweep never runs
 *   - the user path (capability granted) runs the sweep -> 200
 *   - never 500s: a thrown runDueEngagements returns a zeroed, skipped 200
 */
const mockRunDueEngagements = jest.fn();
const mockTrackEvent = jest.fn();
const mockRequireCapability = jest.fn();
const mockRunSweepWithHealth = jest.fn();

jest.mock("@/lib/platform-scan/engage/orchestrator", () => ({
  runDueEngagements: (...a: unknown[]) => mockRunDueEngagements(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
// Mock the health wrapper so the route test never touches a real DB or notifier.
// We faithfully re-implement its catch-and-classify contract: run the sweep,
// catch a throw into a `failed` run with results=[], else classify outcomes.
jest.mock("@/lib/platform-scan/sweep-health", () => {
  const engagementOutcome = (r: { platform: string; skipped?: string }) =>
    r.skipped && r.skipped.startsWith("error:")
      ? { target: r.platform, ok: false, reason: r.skipped }
      : { target: r.platform, ok: true, reason: r.skipped };
  return {
    engagementOutcome,
    runSweepWithHealth: (...a: unknown[]) => mockRunSweepWithHealth(...a),
  };
});

import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/engagement-sweep/route";

const SECRET = "cron-secret-xyz";
function get(headers: Record<string, string> = {}) {
  return new NextRequest("https://x.test/api/cron/engagement-sweep", { headers });
}

const ASSESSED = {
  platform: "a",
  profiled: true,
  findingCount: 2,
  criticalCount: 1,
  autoResolvedCount: 0,
  recommendationCount: 1,
};
const SKIPPED = {
  platform: "b",
  profiled: false,
  skipped: "no_static_target",
  findingCount: 0,
  criticalCount: 0,
  autoResolvedCount: 0,
  recommendationCount: 0,
};

let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockRunDueEngagements.mockResolvedValue([ASSESSED, SKIPPED]);
  // Default health wrapper: run the orchestrator, classify, never throw.
  mockRunSweepWithHealth.mockImplementation(
    async (input: {
      kind: string;
      actor: { id: string; role: string };
      run: () => Promise<Array<{ platform: string; skipped?: string }>>;
      outcome: (r: { platform: string; skipped?: string }) => unknown;
    }) => {
      let results: Array<{ platform: string; skipped?: string }> = [];
      let topLevelError: string | null = null;
      try {
        results = await input.run();
      } catch (err) {
        topLevelError = (err as Error).message;
      }
      const outcomes = results.map(input.outcome) as Array<{ ok: boolean }>;
      const failed = outcomes.filter((o) => !o.ok).length;
      const succeeded = outcomes.filter((o) => o.ok).length;
      const status = topLevelError
        ? "failed"
        : failed === 0
          ? "ok"
          : succeeded === 0
            ? "failed"
            : "partial";
      return {
        results,
        health: { runId: "swp_test", status, targetsTotal: results.length, targetsSucceeded: succeeded, targetsFailed: failed, alerted: status !== "ok" },
      };
    },
  );
});

it("cron bearer runs the sweep without a session and aggregates the results", async () => {
  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    assessed: 1,
    total: 2,
    criticals: 1,
    results: [ASSESSED, SKIPPED],
  });
  // bearer bypasses the session gate
  expect(mockRequireCapability).not.toHaveBeenCalled();
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "platform.engagement_run",
    "cron",
    "system",
    expect.objectContaining({ platform: "sweep", criticals: 1 }),
  );
});

it("refuses an unauthorized request (no bearer, denied capability) and never sweeps", async () => {
  mockRequireCapability.mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 403 }),
  });

  const res = await GET(get());

  expect(res.status).toBe(403);
  expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  expect(mockRunDueEngagements).not.toHaveBeenCalled();
});

it("the user path requires settings.manage_team and runs the sweep on success", async () => {
  mockRequireCapability.mockResolvedValue({
    ok: true,
    user: { id: "u-1", role: "admin", workspaceId: "ws-1" },
  });

  const res = await GET(get());

  expect(res.status).toBe(200);
  expect(mockRunDueEngagements).toHaveBeenCalledTimes(1);
  expect(await res.json()).toMatchObject({ ok: true, assessed: 1, total: 2, criticals: 1 });
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "platform.engagement_run",
    "u-1",
    "admin",
    expect.objectContaining({ platform: "sweep" }),
  );
});

it("never 500s: a thrown runDueEngagements returns a zeroed, skipped 200 + a recorded failed run", async () => {
  mockRunDueEngagements.mockRejectedValue(new Error("db down"));

  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(res.status).toBe(200);
  // No longer SILENT: the response carries the failed health summary.
  expect(await res.json()).toMatchObject({
    ok: true,
    skipped: true,
    health: { status: "failed" },
  });
});

it("routes the sweep through the health wrapper (observability + alerting)", async () => {
  await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(mockRunSweepWithHealth).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "engagement", actor: { id: "cron", role: "system" } }),
  );
});

it("surfaces a partial sweep (one target errored) instead of swallowing it", async () => {
  const ERRORED = { ...SKIPPED, skipped: "error:fetch failed" };
  mockRunDueEngagements.mockResolvedValue([ASSESSED, ERRORED]);

  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    health: { status: "partial", targetsFailed: 1, alerted: true },
  });
});
