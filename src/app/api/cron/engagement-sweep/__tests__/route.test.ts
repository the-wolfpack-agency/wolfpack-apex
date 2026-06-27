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

jest.mock("@/lib/platform-scan/engage/orchestrator", () => ({
  runDueEngagements: (...a: unknown[]) => mockRunDueEngagements(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

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

it("never 500s: a thrown runDueEngagements returns a zeroed, skipped 200", async () => {
  mockRunDueEngagements.mockRejectedValue(new Error("db down"));

  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, skipped: true });
});
