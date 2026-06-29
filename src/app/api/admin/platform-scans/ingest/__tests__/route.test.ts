/**
 * Contract for POST /api/admin/platform-scans/ingest.
 *
 * Dual auth (CI bearer CRON_SECRET OR settings.manage_team), body validation,
 * and the mapping into recordScan are exercised with the store + auth + analytics
 * mocked, so no DB is touched. Mirrors the integration-health auth idiom.
 */
const mockRecord = jest.fn();
const mockTrack = jest.fn();
const mockAuthFn = jest.fn();
const mockRateLimit = jest.fn();
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
jest.mock("@/lib/platform-scan/store", () => ({ recordScan: (...a: unknown[]) => mockRecord(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
// The per-caller limiter is REUSED from gate-rate-limit.ts (no duplicate counter
// is built). It is mocked here so no DB is touched; the real lib is unit-tested
// in its own suite.
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
// classifyPage is left REAL (it is a pure function) so these tests prove the
// end-to-end classify-then-persist path: raw observations in, classified
// findings landing in recordScan.

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/ingest/route";
import { WriteQueryError } from "@/lib/db";

const VALID = {
  platform: "acme",
  baseUrl: "https://acme.test",
  findings: [
    {
      route: "/x",
      severity: "high",
      category: "bug",
      title: "t",
      detail: "d",
      evidence: { count: 1 },
    },
  ],
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockRecord.mockResolvedValue({ scanId: "scan-1", findingCount: 1, criticalCount: 0 });
  // Default: under the limit so existing behavior is unchanged.
  mockRateLimit.mockResolvedValue({ ok: true, remaining: 119 });
});

it("200 via bearer CRON_SECRET (CI path), records as the browser-scan agent into default ws", async () => {
  const res = await post(VALID, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, scanId: "scan-1", findingCount: 1 });
  expect(mockAuthFn).not.toHaveBeenCalled();
  expect(mockRecord).toHaveBeenCalledWith({
    workspaceId: "default",
    actorId: "browser-scan",
    actorRole: "agent",
    result: {
      platform: "acme",
      baseUrl: "https://acme.test",
      routeCount: 1,
      okCount: 0,
      findings: VALID.findings,
    },
  });
});

it("200 via capability (user path), records with the user's id/role/workspace", async () => {
  const res = await post(VALID); // no bearer
  expect(res.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin" }),
  );
});

it("honors body.routeCount over findings.length", async () => {
  await post({ ...VALID, routeCount: 9 }, { authorization: "Bearer s3cret" });
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({ result: expect.objectContaining({ routeCount: 9 }) }),
  );
});

it("401/403s when neither auth path succeeds (no record call)", async () => {
  process.env.CRON_SECRET = ""; // cron path disabled
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
  const res = await post(VALID);
  expect(res.status).toBe(401);
  expect(mockRecord).not.toHaveBeenCalled();
});

it("cron path is disabled when CRON_SECRET is unset (falls through to capability)", async () => {
  delete process.env.CRON_SECRET;
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await post(VALID, { authorization: "Bearer anything" });
  expect(res.status).toBe(403);
});

it("400 when platform/baseUrl missing or findings is not an array", async () => {
  const auth = { authorization: "Bearer s3cret" };
  expect((await post({ baseUrl: "u", findings: [] }, auth)).status).toBe(400);
  expect((await post({ platform: "p", findings: [] }, auth)).status).toBe(400);
  expect((await post({ platform: "p", baseUrl: "u", findings: "nope" }, auth)).status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

it("400 on invalid JSON body", async () => {
  const res = await post("{not json", { authorization: "Bearer s3cret" });
  expect(res.status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

// CONTRACT CHANGE (data-loss fix): a recordScan throw is a PERSISTENCE FAILURE,
// not a success. The route used to return { ok:true, scanId:null, findingCount:0 }
// at 200 - a false success that made the CI runner mark the run green and DISCARD
// the only copy of the findings. It now returns a non-2xx + ok:false so the caller
// RETRIES, and fires platform.scan_persist_degraded so the dropped run is recorded.
// (This test previously asserted the OLD zeroed-200 contract; updated.)
it("CONTRACT: a real store write error returns 500 + ok:false + fires scan_persist_degraded (NOT a zeroed 200)", async () => {
  mockRecord.mockRejectedValue(new Error("db down"));
  const res = await post(VALID, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.error).toBe("persist_failed");
  expect(mockTrack).toHaveBeenCalledWith(
    "platform.scan_persist_degraded",
    "browser-scan",
    "agent",
    expect.objectContaining({ surface: "ingest", platform: "acme", finding_count: 1 }),
  );
});

it("CONTRACT: a no_database (shadow-mode) WriteQueryError returns 503 + ok:false + scan_persist_degraded", async () => {
  // shadow mode (DATABASE_URL unset) is exactly the case the old code dropped data
  // on: writeQuery throws no_database, the catch said ok:true, and the runner moved
  // on. Now it is a 503 (explicitly NOT ok) so nothing is silently discarded.
  mockRecord.mockRejectedValue(new WriteQueryError("no db", "no_database"));
  const res = await post(VALID, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.reason).toBe("no_database");
  expect(mockTrack).toHaveBeenCalledWith(
    "platform.scan_persist_degraded",
    "browser-scan",
    "agent",
    expect.objectContaining({ surface: "ingest" }),
  );
});

it("LEGIT 200: an empty observations[] (nothing to ingest) still records a 0-finding scan at 200", async () => {
  // 'tried and failed' (above) is distinct from 'nothing to ingest'. An empty but
  // PRESENT source array with platform+baseUrl is a valid scan that found nothing;
  // recordScan succeeds and the route returns a clean 200 - no degrade event.
  mockRecord.mockResolvedValue({ scanId: "scan-empty", findingCount: 0, criticalCount: 0 });
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test", observations: [] },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, scanId: "scan-empty", findingCount: 0 });
  expect(mockTrack).not.toHaveBeenCalledWith(
    "platform.scan_persist_degraded",
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
});

// --- Raw-observations path (apex classifies SERVER-SIDE via classifyPage) ---

/** A page whose only flaw is an icon-only interactive control with no
 *  accessible name and no text - the classic ux_gap the UX detectors catch. */
const UX_OBSERVATION = {
  route: "/dash",
  journey: "dashboard",
  status: 200,
  consoleErrors: [],
  cspViolations: [],
  failedRequests: [],
  renderedContent: true,
  durationMs: 120,
  elements: [{ tag: "button", role: "button", interactive: true }],
};

/** A clean page: 200, content rendered, no error/CSP/failed signals, no flagged
 *  elements -> classifyPage yields []. */
const HEALTHY_OBSERVATION = {
  route: "/ok",
  journey: "home",
  status: 200,
  consoleErrors: [],
  cspViolations: [],
  failedRequests: [],
  renderedContent: true,
  durationMs: 80,
  elements: [{ tag: "button", role: "button", interactive: true, accessibleName: "Save" }],
};

it("observations[] are classified SERVER-SIDE and the findings land in recordScan", async () => {
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test", observations: [UX_OBSERVATION] },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(200);
  // routeCount defaults to observations.length when observations drive the request.
  const call = mockRecord.mock.calls[0][0];
  expect(call.result.routeCount).toBe(1);
  // The classifier (REAL, pure) produced the ux_gap finding; assert it landed.
  expect(call.result.findings).toEqual([
    expect.objectContaining({
      route: "/dash",
      category: "ux_gap",
      severity: "medium",
      title: "Interactive control has no accessible name",
    }),
  ]);
});

it("a healthy observation classifies to 0 findings", async () => {
  await post(
    { platform: "acme", baseUrl: "https://acme.test", observations: [HEALTHY_OBSERVATION] },
    { authorization: "Bearer s3cret" },
  );
  const call = mockRecord.mock.calls[0][0];
  expect(call.result.findings).toEqual([]);
  expect(call.result.routeCount).toBe(1);
});

it("mixed observations[] + findings[]: both sources land in the same scan", async () => {
  const res = await post(
    {
      platform: "acme",
      baseUrl: "https://acme.test",
      findings: VALID.findings,
      observations: [UX_OBSERVATION],
    },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(200);
  const call = mockRecord.mock.calls[0][0];
  // Direct finding first, then classified finding from the observation.
  expect(call.result.findings).toEqual([
    expect.objectContaining({ route: "/x", category: "bug" }),
    expect.objectContaining({ route: "/dash", category: "ux_gap" }),
  ]);
  // observations drive routeCount even when findings[] are also present.
  expect(call.result.routeCount).toBe(1);
});

it("400 when neither findings[] nor observations[] is provided", async () => {
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test" },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

it("observations[]-only request works under the capability (user) auth path", async () => {
  const res = await post({
    platform: "acme",
    baseUrl: "https://acme.test",
    observations: [UX_OBSERVATION],
  }); // no bearer -> capability path
  expect(res.status).toBe(200);
  expect(mockAuthFn).toHaveBeenCalled();
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin" }),
  );
});

// --- Tier-2 journey-traces path (apex classifies SERVER-SIDE via classifyJourney) ---

/** A dead-end journey: the agent could not complete the goal -> high ux_gap. */
const DEADEND_TRACE = {
  route: "/billing",
  journey: "billing",
  goal: "create an invoice",
  completed: false,
  steps: [
    { action: "navigate", ok: true },
    { action: "click", ok: true },
  ],
};

/** A clean, completed, optimal journey -> classifyJourney yields []. */
const HEALTHY_TRACE = {
  route: "/ok",
  journey: "home",
  goal: "open the home page",
  completed: true,
  steps: [
    { action: "navigate", ok: true },
    { action: "observe", ok: true },
  ],
};

it("traces[] are classified SERVER-SIDE and the friction findings land in recordScan", async () => {
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test", traces: [DEADEND_TRACE] },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(200);
  const call = mockRecord.mock.calls[0][0];
  // traces drive routeCount (one journey covered).
  expect(call.result.routeCount).toBe(1);
  // The classifier (REAL, pure) produced the dead-end finding; assert it landed.
  expect(call.result.findings).toEqual([
    expect.objectContaining({
      route: "/billing",
      category: "ux_gap",
      severity: "high",
      title: "Journey could not be completed",
    }),
  ]);
});

it("a healthy trace classifies to 0 findings", async () => {
  await post(
    { platform: "acme", baseUrl: "https://acme.test", traces: [HEALTHY_TRACE] },
    { authorization: "Bearer s3cret" },
  );
  const call = mockRecord.mock.calls[0][0];
  expect(call.result.findings).toEqual([]);
  expect(call.result.routeCount).toBe(1);
});

it("findings[] + observations[] + traces[] all land in the same scan, in source order", async () => {
  const res = await post(
    {
      platform: "acme",
      baseUrl: "https://acme.test",
      findings: VALID.findings,
      observations: [UX_OBSERVATION],
      traces: [DEADEND_TRACE],
    },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(200);
  const call = mockRecord.mock.calls[0][0];
  expect(call.result.findings).toEqual([
    expect.objectContaining({ route: "/x", category: "bug" }),
    expect.objectContaining({ route: "/dash", category: "ux_gap" }),
    expect.objectContaining({ route: "/billing", title: "Journey could not be completed" }),
  ]);
  // observations.length (1) + traces.length (1) = 2 probed units.
  expect(call.result.routeCount).toBe(2);
});

it("traces[]-only request works under the capability (user) auth path", async () => {
  const res = await post({
    platform: "acme",
    baseUrl: "https://acme.test",
    traces: [DEADEND_TRACE],
  }); // no bearer -> capability path
  expect(res.status).toBe(200);
  expect(mockAuthFn).toHaveBeenCalled();
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin" }),
  );
});

it("400 when none of findings[]/observations[]/traces[] is provided", async () => {
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test" },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

// --- Abuse hardening: rate limit + payload caps (auth -> rate -> cap -> work) ---

const finding = (i: number) => ({
  route: `/r${i}`,
  severity: "low",
  category: "bug",
  title: "t",
  detail: "d",
  evidence: { i },
});

it("REGRESSION: a normal request (within caps, under limit) is unchanged 200 + records", async () => {
  const res = await post(VALID, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, scanId: "scan-1", findingCount: 1 });
  // Rate limit consulted, keyed by workspace; recordScan still called.
  expect(mockRateLimit).toHaveBeenCalledWith("ingest:default");
  expect(mockRecord).toHaveBeenCalledTimes(1);
  // No reject analytics fired for a legitimate request.
  expect(mockTrack).not.toHaveBeenCalledWith(
    "platform.scan_ingest_rejected",
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
});

it("rate-limit consults the limiter keyed by the user's workspace (capability path)", async () => {
  await post(VALID); // capability path -> ws-1
  expect(mockRateLimit).toHaveBeenCalledWith("ingest:ws-1");
});

it("429 + Retry-After + reject analytics + no record when rate-limited", async () => {
  mockRateLimit.mockResolvedValue({ ok: false, remaining: 0 });
  const res = await post(VALID, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
  expect(await res.json()).toEqual({ ok: false, error: "rate_limited" });
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith(
    "platform.scan_ingest_rejected",
    "browser-scan",
    "agent",
    { reason: "rate_limited", workspace_id: "default" },
  );
});

it("rate-limit ok -> proceeds to recordScan", async () => {
  mockRateLimit.mockResolvedValue({ ok: true, remaining: 5 });
  const res = await post(VALID, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledTimes(1);
});

it("413 + reject analytics + no record when total items exceed the cap", async () => {
  const findings = Array.from({ length: 1001 }, (_, i) => finding(i));
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test", findings },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ ok: false, error: "payload_too_large" });
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith(
    "platform.scan_ingest_rejected",
    "browser-scan",
    "agent",
    { reason: "payload_too_large", workspace_id: "default" },
  );
});

it("413 when the combined total across arrays exceeds the cap (each array under per-array cap)", async () => {
  // 600 + 600 = 1200 total > 1000, but each array (600) is under the 1000 per-array cap.
  const findings = Array.from({ length: 600 }, (_, i) => finding(i));
  const traces = Array.from({ length: 600 }, (_, i) => ({
    route: `/t${i}`,
    journey: "j",
    goal: "g",
    completed: true,
    steps: [{ action: "navigate", ok: true }],
  }));
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test", findings, traces },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(413);
  expect(mockRecord).not.toHaveBeenCalled();
});

it("413 when a single item is absurdly large (per-item byte guard)", async () => {
  const huge = { ...finding(0), detail: "x".repeat(70 * 1024) };
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test", findings: [huge] },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(413);
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith(
    "platform.scan_ingest_rejected",
    "browser-scan",
    "agent",
    { reason: "payload_too_large", workspace_id: "default" },
  );
});

it("exactly at the cap (1000 items) is allowed (boundary, generous limit)", async () => {
  const findings = Array.from({ length: 1000 }, (_, i) => finding(i));
  const res = await post(
    { platform: "acme", baseUrl: "https://acme.test", findings },
    { authorization: "Bearer s3cret" },
  );
  expect(res.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledTimes(1);
});

it("auth is enforced FIRST: unauth -> 401 before any rate-limit or cap check", async () => {
  process.env.CRON_SECRET = ""; // cron path disabled
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
  // Even an over-cap payload must be rejected by auth first.
  const findings = Array.from({ length: 5000 }, (_, i) => finding(i));
  const res = await post({ platform: "acme", baseUrl: "https://acme.test", findings });
  expect(res.status).toBe(401);
  expect(mockRateLimit).not.toHaveBeenCalled();
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockTrack).not.toHaveBeenCalled();
});
