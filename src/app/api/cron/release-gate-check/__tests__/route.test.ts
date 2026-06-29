/**
 * GET /api/cron/release-gate-check - the proactive release-gate notifier route.
 *
 * Pins: the cron bearer path runs without a session + returns the summary; the
 * admin path requires settings.manage_team; an unauthorized request is refused;
 * a degraded gate read returns degraded:true + sends nothing; a top-level throw
 * is swallowed to a 200 so the cron monitor stays green.
 */
const mockCheckAndNotify = jest.fn();
const mockRequireCapability = jest.fn();

jest.mock("@/lib/deploy/release-gate-notify", () => ({
  checkAndNotify: (...a: unknown[]) => mockCheckAndNotify(...a),
  blockedMessage: () => "msg",
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/notifications/in-app", () => ({ notify: jest.fn() }));
jest.mock("@/lib/mail/send-via-graph", () => ({ sendViaGraph: jest.fn() }));
jest.mock("@/lib/deploy/release-gate", () => ({ getReleaseGate: jest.fn() }));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn().mockResolvedValue({ rows: [] }) }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/release-gate-check/route";

const SECRET = "cron-secret-xyz";
function get(headers: Record<string, string> = {}) {
  return new NextRequest("https://x.test/api/cron/release-gate-check", { headers });
}

let savedSecret: string | undefined;
let savedEmailFlag: string | undefined;
beforeAll(() => {
  savedSecret = process.env.CRON_SECRET;
  savedEmailFlag = process.env.RELEASE_GATE_EMAIL_ALERTS;
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
  if (savedEmailFlag === undefined) delete process.env.RELEASE_GATE_EMAIL_ALERTS;
  else process.env.RELEASE_GATE_EMAIL_ALERTS = savedEmailFlag;
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RELEASE_GATE_EMAIL_ALERTS;
  mockCheckAndNotify.mockResolvedValue({
    checked: 2,
    notified: 1,
    degraded: false,
    failures: 0,
    dedupeUnavailable: false,
    suppressed: 0,
  });
});

it("the cron bearer path runs the sweep without a session and returns the summary", async () => {
  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, checked: 2, notified: 1 });
  expect(mockRequireCapability).not.toHaveBeenCalled();
  expect(mockCheckAndNotify).toHaveBeenCalledTimes(1);
});

it("email is OFF (emailEnabled:false) when RELEASE_GATE_EMAIL_ALERTS is unset", async () => {
  await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(mockCheckAndNotify).toHaveBeenCalledWith(
    expect.objectContaining({ emailEnabled: false }),
  );
});

it("email is ON (emailEnabled:true) only when RELEASE_GATE_EMAIL_ALERTS === '1'", async () => {
  process.env.RELEASE_GATE_EMAIL_ALERTS = "1";
  await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(mockCheckAndNotify).toHaveBeenCalledWith(
    expect.objectContaining({ emailEnabled: true }),
  );
});

it("any value other than '1' for RELEASE_GATE_EMAIL_ALERTS keeps email OFF", async () => {
  process.env.RELEASE_GATE_EMAIL_ALERTS = "true";
  await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(mockCheckAndNotify).toHaveBeenCalledWith(
    expect.objectContaining({ emailEnabled: false }),
  );
});

it("surfaces dedupeUnavailable + suppressed in the summary", async () => {
  mockCheckAndNotify.mockResolvedValue({
    checked: 3,
    notified: 0,
    degraded: false,
    failures: 0,
    dedupeUnavailable: true,
    suppressed: 1,
  });
  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(await res.json()).toMatchObject({ ok: true, dedupeUnavailable: true, suppressed: 1 });
});

it("the admin path requires settings.manage_team and runs on success", async () => {
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  const res = await GET(get());
  expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  expect(res.status).toBe(200);
  expect(mockCheckAndNotify).toHaveBeenCalledTimes(1);
});

it("refuses an unauthorized request (no bearer, no capability)", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
  const res = await GET(get());
  expect(res.status).toBe(401);
  expect(mockCheckAndNotify).not.toHaveBeenCalled();
});

it("surfaces a degraded gate read honestly (degraded:true, nothing claimed clear)", async () => {
  mockCheckAndNotify.mockResolvedValue({
    checked: 0,
    notified: 0,
    degraded: true,
    degradedDetail: "Could not reach GitHub",
    failures: 0,
  });
  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, degraded: true, degradedDetail: "Could not reach GitHub", notified: 0 });
});

it("never 500s: a thrown sweep returns a zeroed 200", async () => {
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  mockCheckAndNotify.mockRejectedValue(new Error("db down"));
  const res = await GET(get({ authorization: `Bearer ${SECRET}` }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, checked: 0, notified: 0 });
  errSpy.mockRestore();
});
