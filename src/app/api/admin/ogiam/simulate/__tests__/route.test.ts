/**
 * Contract tests for POST /api/admin/ogiam/simulate. Locks the auth gate
 * (401/403), body validation (400 on empty/invalid enforceCapabilities), the
 * happy-path report shape, and the ogiam.policy_simulated analytics emit. The
 * simulator lib is mocked so this stays a pure contract test.
 */

export {};

const mockRequireCapability = jest.fn();
const mockRun = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ogiam/simulate", () => ({
  runEnforcementSimulation: (...a: unknown[]) => mockRun(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "../route";

function req(body?: unknown): NextRequest {
  return new NextRequest("https://x.test/api/admin/ogiam/simulate", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const sampleReport = { windowDays: 30, decisions: 12, currentlyBlocked: 1, newlyBlocked: 3, unaffected: 9, candidateCapabilities: ["finance.write"], byCapability: [], byAgent: [], byOutcome: { escalate: 3 }, samples: [] };

beforeEach(() => {
  jest.resetAllMocks();
  mockRun.mockResolvedValue(sampleReport);
});

test("401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
  const res = await POST(req({ enforceCapabilities: ["finance.write"] }));
  expect(res.status).toBe(401);
  expect(mockRun).not.toHaveBeenCalled();
});

test("403 when caller lacks settings.manage_team", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await POST(req({ enforceCapabilities: ["x"] }))).status).toBe(403);
});

test("400 when enforceCapabilities is empty/missing", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  expect((await POST(req({ enforceCapabilities: [] }))).status).toBe(400);
  expect((await POST(req({}))).status).toBe(400);
  expect(mockRun).not.toHaveBeenCalled();
});

test("400 on invalid JSON", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const bad = new NextRequest("https://x.test/api/admin/ogiam/simulate", {
    method: "POST",
    headers: { authorization: "Bearer t" },
    body: "{not json",
  });
  expect((await POST(bad)).status).toBe(400);
});

test("200 returns the report and emits ogiam.policy_simulated", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await POST(req({ enforceCapabilities: ["finance.write"], windowDays: 30 }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.report.newlyBlocked).toBe(3);
  // Scoped to the caller's workspace.
  expect(mockRun).toHaveBeenCalledWith("w-1", { enforceCapabilities: ["finance.write"] }, 30);
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "ogiam.policy_simulated",
    "u-1",
    "cto",
    expect.objectContaining({ window_days: 30, decisions: 12, newly_blocked: 3, currently_blocked: 1 }),
  );
});

test("filters non-string capabilities out of the candidate set", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  await POST(req({ enforceCapabilities: ["finance.write", 42, "", "mail.send"] }));
  expect(mockRun).toHaveBeenCalledWith("w-1", { enforceCapabilities: ["finance.write", "mail.send"] }, 30);
});
