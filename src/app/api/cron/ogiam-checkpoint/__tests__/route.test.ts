/**
 * Contract tests for GET /api/cron/ogiam-checkpoint.
 *
 * Covers: the cron bearer happy path runs the sweep and returns the
 * counts; a missing/wrong secret with no capability is denied (401);
 * a recoverable throw inside the sweep degrades to a 200 zeroed result
 * (cron health monitor stays green); the user "Run now" path runs the
 * sweep when the capability check passes.
 */

const mockRunCheckpointSweep = jest.fn();
const mockRequireCapability = jest.fn();

jest.mock("@/lib/ogiam/checkpoint", () => ({
  runCheckpointSweep: (...a: unknown[]) => mockRunCheckpointSweep(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  mockRunCheckpointSweep.mockReset();
  mockRequireCapability.mockReset();
  process.env.CRON_SECRET = "secret-x";
});

afterAll(() => {
  process.env = ORIG_ENV;
});

function reqWith(auth?: string): NextRequest {
  return new NextRequest("https://wp.test/api/cron/ogiam-checkpoint", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("GET /api/cron/ogiam-checkpoint", () => {
  test("cron bearer happy path: runs the sweep and returns the counts", async () => {
    mockRunCheckpointSweep.mockResolvedValueOnce({ workspaces: 3, written: 2 });

    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ workspaces: 3, written: 2 });
    expect(mockRunCheckpointSweep).toHaveBeenCalledTimes(1);
    // Capability check is never consulted on the cron path.
    expect(mockRequireCapability).not.toHaveBeenCalled();
  });

  test("wrong secret AND no capability -> 401, sweep never runs", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });

    const res = await GET(reqWith("Bearer wrong"));

    expect(res.status).toBe(401);
    expect(mockRunCheckpointSweep).not.toHaveBeenCalled();
  });

  test("missing auth header -> capability path denies with 403", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    const res = await GET(reqWith());

    expect(res.status).toBe(403);
    expect(mockRunCheckpointSweep).not.toHaveBeenCalled();
  });

  test("user 'Run now' path: capability granted runs the sweep", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { id: "u-1", role: "cto", workspaceId: "default" },
      capabilities: new Set(["settings.manage_team"]),
    });
    mockRunCheckpointSweep.mockResolvedValueOnce({ workspaces: 1, written: 1 });

    const res = await GET(reqWith("Bearer not-the-cron-secret"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.result).toEqual({ workspaces: 1, written: 1 });
    expect(mockRunCheckpointSweep).toHaveBeenCalledTimes(1);
  });

  test("recoverable throw in the sweep degrades to a 200 zeroed result", async () => {
    mockRunCheckpointSweep.mockRejectedValueOnce(new Error("no DATABASE_URL"));

    const res = await GET(reqWith("Bearer secret-x"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(body.result).toEqual({ workspaces: 0, written: 0 });
  });
});
