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
// classifyPage is left REAL (it is a pure function) so these tests prove the
// end-to-end classify-then-persist path: raw observations in, classified
// findings landing in recordScan.

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/ingest/route";

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

it("never 500s: a store throw returns a zeroed 200", async () => {
  mockRecord.mockRejectedValue(new Error("db down"));
  const res = await post(VALID, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, scanId: null, findingCount: 0 });
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
