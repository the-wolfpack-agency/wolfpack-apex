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
