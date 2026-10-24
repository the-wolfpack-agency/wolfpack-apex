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
// Mock the health wrapper's I/O only: the route calls the REAL runSweepWithHealth
// and engagementOutcome (so the real classification and status table are exercised), with
// injected deps so no real DB, notifier or analytics row is touched.
const sweepEvents: string[] = [];
jest.mock("@/lib/platform-scan/sweep-health", () => {
  const actual = jest.requireActual("@/lib/platform-scan/sweep-health");
  return {
    ...actual,
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
  sweepEvents.length = 0;
  const actual = jest.requireActual("@/lib/platform-scan/sweep-health");
  mockRunSweepWithHealth.mockImplementation((input: unknown) =>
    actual.runSweepWithHealth(input, {
      insertRun: async () => {},
      previousStatus: async () => null,
      notify: async () => ({ id: "n1" }),
      trackEvent: (event: string) => {
        sweepEvents.push(event);
      },
      now: () => new Date("2026-10-24T12:00:00.000Z"),
      newId: () => "swp_test",
    }),
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

describe("CRON_SECRET contract", () => {
  const unauth = () =>
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

  it("200 with the correct bearer", async () => {
    const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  it("401 with no authorization header and no session; the sweep never runs", async () => {
    unauth();
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(mockRunDueEngagements).not.toHaveBeenCalled();
  });

  it("401 with a wrong CRON_SECRET (falls through to the session guard, which refuses)", async () => {
    unauth();
    const res = await GET(get({ authorization: "Bearer not-the-secret" }));
    expect(res.status).toBe(401);
    expect(mockRequireCapability).toHaveBeenCalled();
    expect(mockRunDueEngagements).not.toHaveBeenCalled();
  });

  it("401 when CRON_SECRET is unset, even for a bearer that would match an empty secret", async () => {
    unauth();
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await GET(get({ authorization: "Bearer " }));
      expect(res.status).toBe(401);
      expect(mockRunDueEngagements).not.toHaveBeenCalled();
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });
});

describe("sweep honesty", () => {
  it("zero targets -> 200 with health no_targets and sweep_no_targets, never sweep_completed", async () => {
    mockRunDueEngagements.mockResolvedValue([]);
    const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, total: 0, health: { status: "no_targets", targetsTotal: 0 } });
    expect(sweepEvents).toEqual(["platform.sweep_no_targets"]);
  });

  it("every target skipped -> no_targets, not ok", async () => {
    mockRunDueEngagements.mockResolvedValue([SKIPPED]);
    const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
    expect(await res.json()).toMatchObject({ health: { status: "no_targets", targetsSkipped: 1, targetsSucceeded: 0 } });
    expect(sweepEvents).not.toContain("platform.sweep_completed");
  });

  it("one assessed + one skipped -> partial (a skipped target is not a success)", async () => {
    const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
    expect(await res.json()).toMatchObject({ health: { status: "partial", targetsSucceeded: 1, targetsSkipped: 1, targetsFailed: 0 } });
  });
});
