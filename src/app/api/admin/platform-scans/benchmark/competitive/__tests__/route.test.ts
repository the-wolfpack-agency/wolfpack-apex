/**
 * Contract for /api/admin/platform-scans/benchmark/competitive.
 *
 * POST normalizes a competitor's raw findings into OUR taxonomy, scores them with
 * the SAME scorer vs corpus GROUND TRUTH, reads OUR latest score for the target
 * (from listRecentBenchmarkRuns), builds the head-to-head, fires the 3 competitive
 * events appropriately (competitor_benchmark_run always; competitor_gap_detected on
 * a rival-only class; competitive_parity_confirmed when we match/beat all), persists
 * via recordCompetitorRun, audits, and returns the report(s). GET returns
 * { comparison, improvement }. Dual auth (cron OR capability) + unauth + a 400 on a
 * non-corpus target are exercised.
 *
 * The scorer + corpus + competitive core are REAL (the score path is proven end to
 * end); only db reads, persistence, analytics, and audit are mocked - no DB touched.
 */
const mockListRuns = jest.fn();
const mockOurScore = jest.fn();
const mockListLatestPerPair = jest.fn();
const mockRecordRun = jest.fn();
const mockTrack = jest.fn();
const mockRecordAudit = jest.fn();
const mockAuthFn = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: () => {
    mockAuthFn();
    return mockAuth();
  },
}));
jest.mock("@/lib/platform-scan/benchmark/benchmark-store", () => ({
  // Still used by GET's improvement trend.
  listRecentBenchmarkRuns: (...a: unknown[]) => mockListRuns(...a),
}));
jest.mock("@/lib/platform-scan/benchmark/competitive-store", () => ({
  recordCompetitorRun: (...a: unknown[]) => mockRecordRun(...a),
  // FIX #5/#7: POST reads OUR latest score per-target directly; GET reads latest
  // competitor run per (tool, target) via DISTINCT ON.
  ourLatestScoreForTarget: (...a: unknown[]) => mockOurScore(...a),
  listLatestCompetitorRunPerPair: (...a: unknown[]) => mockListLatestPerPair(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "req-1" }),
}));
// scorer + corpus + competitive core are REAL.

import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/admin/platform-scans/benchmark/competitive/route";

const VAMPI = "vampi";

function makePost(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans/benchmark/competitive", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function makeGet(headers: Record<string, string> = {}) {
  return GET(
    new NextRequest("http://localhost/api/admin/platform-scans/benchmark/competitive", {
      method: "GET",
      headers,
    }),
  );
}

/** OUR latest score for vampi with the given matched GT classes - a labeled,
 *  scored run so parity is claimable. Shapes what ourLatestScoreForTarget returns. */
function oursForVampi(matched: string[]) {
  return {
    target: VAMPI,
    recall: matched.length / 5,
    precision: 1,
    matched,
    labeled: true,
    hasRun: true,
    runAt: "2026-06-28T00:00:00.000Z",
  };
}

/** The "we never scored this target" shape: recall unknown (null), hasRun false. */
function oursNoRun() {
  return {
    target: VAMPI,
    recall: null,
    precision: null,
    matched: [],
    labeled: true,
    hasRun: false,
    runAt: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockListRuns.mockResolvedValue([]);
  mockOurScore.mockResolvedValue(oursNoRun());
  mockListLatestPerPair.mockResolvedValue([]);
  mockRecordRun.mockResolvedValue({ id: "comp_1" });
  mockRecordAudit.mockResolvedValue({ ok: true });
});

describe("POST (score a competitor vs us)", () => {
  test("scores nuclei vs vampi, fires the run event, persists, audits, returns the report", async () => {
    mockOurScore.mockResolvedValue(oursForVampi(["security:SQL injection"]));
    const res = await makePost(
      { tool: "nuclei", target: VAMPI, findings: [{ templateId: "sqli" }, { templateId: "idor" }] },
      { authorization: "Bearer s3cret" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // The head-to-head run event fired once for the tool/target.
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.competitor_benchmark_run",
      "benchmark-scorer",
      "agent",
      expect.objectContaining({ tool: "nuclei", target: VAMPI }),
    );

    // We matched only SQLi; nuclei also caught IDOR -> rival-only gap + gap event.
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.competitor_gap_detected",
      "benchmark-scorer",
      "agent",
      expect.objectContaining({
        tool: "nuclei",
        target: VAMPI,
        finding_class: "security:Broken object level authorization (IDOR)",
      }),
    );
    expect(body.reports[0].rivalOnlyGaps).toEqual([
      { findingClass: "security:Broken object level authorization (IDOR)", tools: ["nuclei"] },
    ]);
    expect(body.reports[0].parity).toBe(false);

    // Persisted once + audited.
    expect(mockRecordRun).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.competitor_benchmark_scored" }),
    );
    expect(body.runIds).toEqual(["comp_1"]);
  });

  test("fires competitive_parity_confirmed when we match/beat the rival", async () => {
    mockOurScore.mockResolvedValue(
      oursForVampi([
        "security:SQL injection",
        "security:Broken object level authorization (IDOR)",
      ]),
    );
    const res = await makePost(
      { tool: "nuclei", target: VAMPI, findings: [{ templateId: "sqli" }] },
      { authorization: "Bearer s3cret" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reports[0].parity).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.competitive_parity_confirmed",
      "benchmark-scorer",
      "agent",
      expect.objectContaining({ target: VAMPI, tools_compared: 1 }),
    );
  });

  test("accepts an ARRAY of entries (multi-tool sweep) and scores each", async () => {
    mockOurScore.mockResolvedValue(oursForVampi([]));
    const res = await makePost(
      [
        { tool: "zap", target: VAMPI, findings: [{ alert: "SQL Injection" }] },
        { tool: "nuclei", target: VAMPI, findings: [{ templateId: "idor" }] },
      ],
      { authorization: "Bearer s3cret" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reports).toHaveLength(2);
    expect(mockRecordRun).toHaveBeenCalledTimes(2);
  });

  test("capability path attributes events + audit to the user", async () => {
    mockOurScore.mockResolvedValue(oursForVampi([]));
    const res = await makePost({ tool: "zap", target: VAMPI, findings: [] }); // no bearer
    expect(res.status).toBe(200);
    expect(mockAuthFn).toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { user_id: "admin-1", role: "admin" } }),
    );
  });

  test("400 on a non-corpus target (the open internet is never benchmarkable)", async () => {
    const res = await makePost(
      { tool: "zap", target: "https://evil.example.com", findings: [] },
      { authorization: "Bearer s3cret" },
    );
    expect(res.status).toBe(400);
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  test("400 on a malformed entry (bad tool)", async () => {
    const res = await makePost(
      { tool: "metasploit", target: VAMPI, findings: [] },
      { authorization: "Bearer s3cret" },
    );
    expect(res.status).toBe(400);
  });

  test("401 when neither auth path succeeds (no scoring, no persist)", async () => {
    process.env.CRON_SECRET = "";
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await makePost({ tool: "zap", target: VAMPI, findings: [] });
    expect(res.status).toBe(401);
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  test("403 when the capability is denied (cron disabled)", async () => {
    delete process.env.CRON_SECRET;
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await makePost({ tool: "zap", target: VAMPI, findings: [] }, { authorization: "Bearer x" });
    expect(res.status).toBe(403);
  });

  test("FIX #5: when we have NO scored run for the target, recall/parity render n/a (null), never a false 0 + false parity", async () => {
    // ourLatestScoreForTarget returns the no-run shape (recall null, hasRun false).
    // The rival also finds nothing mappable. Old code defaulted us to recall 0 and
    // could claim parity (rivalOnlyGaps empty). Now: parity is null (not claimable)
    // and our recall is null (unknown), not a fabricated 0 that understates us.
    mockOurScore.mockResolvedValue(oursNoRun());
    const res = await makePost(
      { tool: "nuclei", target: VAMPI, findings: [{ templateId: "banner-disclosure" }] },
      { authorization: "Bearer s3cret" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reports[0].ours.recall).toBeNull();
    expect(body.reports[0].parity).toBeNull();
    // No parity event fired - we never claim "matched/beat every tool" without a run.
    expect(mockTrack).not.toHaveBeenCalledWith(
      "platform.competitive_parity_confirmed",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    // ourLatestScoreForTarget was queried for the specific target.
    expect(mockOurScore).toHaveBeenCalledWith(VAMPI);
  });

  test("never loses the run: a persistence failure still returns the report (200)", async () => {
    mockOurScore.mockResolvedValue(oursForVampi([]));
    mockRecordRun.mockResolvedValue({ id: null });
    const res = await makePost(
      { tool: "zap", target: VAMPI, findings: [{ alert: "SQL Injection" }] },
      { authorization: "Bearer s3cret" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.runIds).toEqual([null]);
    expect(body.reports).toHaveLength(1);
  });
});

describe("GET (comparison + improvement)", () => {
  test("returns latest per (tool,target) comparison (deduped in SQL) + our improvement trend", async () => {
    // FIX #7: the store now returns latest-per-pair via DISTINCT ON, so the route
    // does NOT client-dedup. We hand it the already-deduped single row per pair.
    mockListLatestPerPair.mockResolvedValue([
      {
        id: "comp_2",
        runAt: "2026-06-28T00:00:00.000Z",
        tool: "nuclei",
        target: VAMPI,
        recall: 0.4,
        precision: 1,
        findings: 5,
        report: { labeled: true, ours: { recall: 0.6, precision: 1, matched: [] }, rivalOnlyGaps: [], parity: true },
      },
    ]);
    mockListRuns.mockResolvedValue([
      { id: "b2", runAt: "2026-06-28T00:00:00.000Z", recall: 0.6, coverageClasses: 12, report: {}, signals: [] },
      { id: "b1", runAt: "2026-06-21T00:00:00.000Z", recall: 0.3, coverageClasses: 9, report: {}, signals: [] },
    ]);

    const res = await makeGet({ authorization: "Bearer admin" });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Only the latest run per (tool,target) is kept.
    expect(body.comparison).toHaveLength(1);
    expect(body.comparison[0]).toMatchObject({
      tool: "nuclei",
      target: VAMPI,
      theirs: { recall: 0.4, precision: 1, findings: 5 },
      ours: { recall: 0.6 },
      parity: true,
    });

    // Improvement trend computed from our runs (latest 0.6 vs prior 0.3).
    expect(body.improvement.latestRecall).toBeCloseTo(0.6, 5);
    expect(body.improvement.recallDelta).toBeCloseTo(0.3, 5);
    expect(body.improvement.coverageDelta).toBe(3);
    expect(body.improvement.series.map((p: { recall: number }) => p.recall)).toEqual([0.3, 0.6]);
  });

  test("401 when unauthenticated", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await makeGet();
    expect(res.status).toBe(401);
    expect(mockListLatestPerPair).not.toHaveBeenCalled();
  });
});
