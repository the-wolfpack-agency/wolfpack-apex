/**
 * Contract tests for POST/GET /api/admin/ogiam/governance-alerts/scan.
 *
 * Asserts the two auth paths (CRON_SECRET bearer vs settings.manage_team vs 401),
 * that a wrong bearer falls through to the capability gate (no secret bypass), the
 * 200 result shape, and that the scan delegates to scanAndDispatch with the right
 * actor. scanAndDispatch (which owns the analytics emit via the notifications
 * layer) is mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockScan = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ogiam/governance-alerts", () => ({
  scanAndDispatch: (...a: unknown[]) => mockScan(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { POST, GET } from "../route";

const req = (auth?: string) =>
  new NextRequest("https://x.test/api/admin/ogiam/governance-alerts/scan", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });
const allow = () => ({
  ok: true,
  user: { id: "u-1", role: "admin", workspaceId: "ws-1" },
  capabilities: new Set(),
});

const cleanScan = { detected: 0, dispatched: 0, deduped: 0, alerts: [] };
const firedScan = {
  detected: 1,
  dispatched: 1,
  deduped: 0,
  alerts: [{ kind: "redteam_passrate_drop", fingerprint: "fp", dispatched: true }],
};

beforeEach(() => {
  jest.resetAllMocks();
  mockScan.mockResolvedValue(cleanScan);
  delete process.env.CRON_SECRET;
});

test("401 with neither a valid cron secret nor an authorized session", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await POST(req())).status).toBe(401);
  expect(mockScan).not.toHaveBeenCalled();
});

test("cron path runs as the system actor", async () => {
  process.env.CRON_SECRET = "s3cret";
  const res = await POST(req("Bearer s3cret"));
  expect(res.status).toBe(200);
  expect(mockScan).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "default", actorId: "cron", actorRole: "system" }),
  );
  expect(mockRequireCapability).not.toHaveBeenCalled();
});

test("a wrong bearer falls through to the capability gate (no secret bypass)", async () => {
  process.env.CRON_SECRET = "s3cret";
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await POST(req("Bearer WRONG"))).status).toBe(403);
  expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
});

test("admin path runs as the caller in their workspace and returns the scan shape", async () => {
  mockRequireCapability.mockResolvedValue(allow());
  mockScan.mockResolvedValue(firedScan);
  const res = await POST(req());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, detected: 1, dispatched: 1, deduped: 0 });
  expect(mockScan).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "ws-1", actorId: "u-1", actorRole: "admin" }),
  );
});

test("GET (Vercel Cron) shares the same auth + run as POST", async () => {
  process.env.CRON_SECRET = "s3cret";
  const res = await GET(req("Bearer s3cret"));
  expect(res.status).toBe(200);
  expect(mockScan).toHaveBeenCalledWith(
    expect.objectContaining({ actorId: "cron", actorRole: "system" }),
  );
});
