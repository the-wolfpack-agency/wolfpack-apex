/**
 * Contract for /api/admin/platform-scans/benchmark.
 *
 * POST scores ALREADY-INGESTED findings (read per corpus target via listFindings)
 * against the corpus GROUND TRUTH, fires the scorer analytics, persists via
 * recordBenchmarkRun, audits, and returns the report + mined signals. A target
 * whose findings read throws is counted errored and the run still completes.
 * GET returns the recent runs for the dashboard. Dual auth (cron OR capability)
 * + unauth are exercised.
 *
 * The scorer + corpus are REAL (the score path is proven end-to-end on the
 * findings we feed in); only db (listFindings), persistence, analytics, and audit
 * are mocked, so no DB is touched.
 */
const mockListFindings = jest.fn();
const mockTrack = jest.fn();
const mockRecordRun = jest.fn();
const mockListRuns = jest.fn();
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
jest.mock("@/lib/platform-scan/store", () => ({
  listFindings: (...a: unknown[]) => mockListFindings(...a),
}));
jest.mock("@/lib/platform-scan/benchmark/benchmark-store", () => ({
  recordBenchmarkRun: (...a: unknown[]) => mockRecordRun(...a),
  listRecentBenchmarkRuns: (...a: unknown[]) => mockListRuns(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.1.1.1", userAgent: "jest", requestId: "req-1" }),
}));
// scorer + corpus are REAL (not mocked) so the end-to-end score path is proven.

import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/admin/platform-scans/benchmark/route";
import { BENCHMARK_CORPUS } from "@/lib/platform-scan/benchmark/corpus";

const JUICE = "self-hosted-juice-shop";

/** A stored finding row whose class key (category:title) matches a juice-shop
 *  ground-truth class, so the scorer counts it as a true positive. */
function row(category: string, title: string, route = "/x") {
  return {
    id: `f_${title}`,
    scanId: "s1",
    platform: JUICE,
    route,
    severity: "high",
    category,
    title,
    detail: "",
    evidence: {},
    status: "open",
    createdAt: "2026-06-19T00:00:00.000Z",
  };
}

function makePost(headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans/benchmark", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

function makeGet(headers: Record<string, string> = {}, qs = "") {
  return GET(
    new NextRequest(`http://localhost/api/admin/platform-scans/benchmark${qs}`, {
      method: "GET",
      headers,
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockRecordRun.mockResolvedValue({ id: "bench_1" });
  mockListRuns.mockResolvedValue([]);
  mockRecordAudit.mockResolvedValue({ ok: true });
  // Default: every target has no open findings.
  mockListFindings.mockResolvedValue([]);
});

describe("POST (trigger a scoring run)", () => {
  test("reads OPEN findings per corpus target and builds one BenchmarkResult each", async () => {
    await makePost({ authorization: "Bearer s3cret" });
    // One listFindings call per corpus target, each scoped to status:open + the
    // target's name as the platform filter.
    expect(mockListFindings).toHaveBeenCalledTimes(BENCHMARK_CORPUS.length);
    for (const t of BENCHMARK_CORPUS) {
      expect(mockListFindings).toHaveBeenCalledWith("default", {
        platform: t.name,
        status: "open",
      });
    }
  });

  test("scores vs ground truth: 2 of 3 juice-shop classes matched -> 1 coverage_gap; analytics fired; persisted", async () => {
    // Return findings matching 2 of the 3 juice-shop ground-truth classes; the
    // 3rd (CORS wildcard) is intentionally absent -> a coverage gap.
    mockListFindings.mockImplementation(async (_ws: string, opts: { platform: string }) => {
      if (opts.platform === JUICE) {
        return [
          row("juice-shop", "SQL injection (login bypass)"),
          row("juice-shop", "DOM XSS (search)"),
        ];
      }
      return [];
    });

    const res = await makePost({ authorization: "Bearer s3cret" });
    expect(res.status).toBe(200);
    const body = await res.json();

    // scoreBenchmark ran (REAL) -> platform.benchmark_run fired once.
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.benchmark_run",
      "system",
      "system",
      expect.objectContaining({ targets: BENCHMARK_CORPUS.length }),
    );
    // extractLearningSignals ran (REAL) -> the missed CORS class became a
    // coverage_gap, emitted as a per-signal event AND returned in the response.
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.learning_signal_detected",
      "system",
      "system",
      expect.objectContaining({
        kind: "coverage_gap",
        finding_class: "security:CORS wildcard with credentials",
      }),
    );
    expect(body.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "coverage_gap",
          findingClass: "security:CORS wildcard with credentials",
        }),
      ]),
    );

    // Report carries the labeled-only recall and the matched classes. The corpus
    // now ships several labeled self-hosted fixtures; this test only feeds
    // findings for juice-shop, so labeledTargets is the count of corpus entries
    // carrying ground truth and recall is the 2 matched juice-shop classes over
    // the total ground-truth across all labeled targets.
    const labeledCorpus = BENCHMARK_CORPUS.filter((t) => (t.groundTruth?.length ?? 0) > 0);
    const truthTotal = labeledCorpus.reduce((n, t) => n + (t.groundTruth?.length ?? 0), 0);
    expect(body.report.labeledTargets).toBe(labeledCorpus.length);
    expect(body.report.recall).toBeCloseTo(2 / truthTotal, 5);

    // Persisted exactly once with the scored report + signals; run id surfaced.
    expect(mockRecordRun).toHaveBeenCalledTimes(1);
    expect(mockRecordRun).toHaveBeenCalledWith(body.report, body.signals);
    expect(body.runId).toBe("bench_1");

    // Audited the scoring run.
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.benchmark_scored", resourceId: "bench_1" }),
    );
  });

  test("a target whose listFindings throws is counted errored and the run still completes", async () => {
    mockListFindings.mockImplementation(async (_ws: string, opts: { platform: string }) => {
      if (opts.platform === BENCHMARK_CORPUS[0].name) throw new Error("store down");
      return [];
    });
    const res = await makePost({ authorization: "Bearer s3cret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.report.erroredCount).toBe(1);
    expect(body.report.targets).toBe(BENCHMARK_CORPUS.length);
    expect(mockRecordRun).toHaveBeenCalledTimes(1);
  });

  test("capability path: scores the caller's workspace, attributes the audit to the user", async () => {
    const res = await makePost(); // no bearer -> capability path
    expect(res.status).toBe(200);
    expect(mockAuthFn).toHaveBeenCalled();
    expect(mockListFindings).toHaveBeenCalledWith("ws-1", expect.any(Object));
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { user_id: "admin-1", role: "admin" } }),
    );
  });

  test("401/403 when neither auth path succeeds (no scoring, no persist)", async () => {
    process.env.CRON_SECRET = ""; // cron disabled
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await makePost();
    expect(res.status).toBe(401);
    expect(mockListFindings).not.toHaveBeenCalled();
    expect(mockRecordRun).not.toHaveBeenCalled();
  });

  test("cron path disabled when CRON_SECRET unset (falls through to capability)", async () => {
    delete process.env.CRON_SECRET;
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await makePost({ authorization: "Bearer anything" });
    expect(res.status).toBe(403);
  });

  test("never loses the run: a persistence failure still returns the scored report (200)", async () => {
    mockRecordRun.mockResolvedValue({ id: null });
    const res = await makePost({ authorization: "Bearer s3cret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.runId).toBeNull();
    expect(body.report).toBeDefined();
  });
});

describe("GET (dashboard trend data)", () => {
  test("returns recent runs under the capability", async () => {
    mockListRuns.mockResolvedValue([{ id: "bench_1", recall: 0.5 }]);
    const res = await makeGet({ authorization: "Bearer admin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runs: [{ id: "bench_1", recall: 0.5 }] });
  });

  test("honors the limit query param", async () => {
    await makeGet({ authorization: "Bearer admin" }, "?limit=5");
    expect(mockListRuns).toHaveBeenCalledWith(5);
  });

  test("401 when unauthenticated", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    const res = await makeGet();
    expect(res.status).toBe(401);
    expect(mockListRuns).not.toHaveBeenCalled();
  });
});
