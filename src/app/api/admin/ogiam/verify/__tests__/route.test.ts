/**
 * Contract tests for GET /api/admin/ogiam/verify.
 *
 * Covers: 401 when the capability check denies; 200 with the
 * { workspace_id, verification, checkpoint } shape when granted, scoped to
 * the caller's workspace.
 */

const mockVerifyChain = jest.fn();
const mockLatestCheckpoint = jest.fn();
const mockRequireCapability = jest.fn();

jest.mock("@/lib/ogiam/checkpoint", () => ({
  verifyChain: (...a: unknown[]) => mockVerifyChain(...a),
  latestCheckpoint: (...a: unknown[]) => mockLatestCheckpoint(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

beforeEach(() => {
  mockVerifyChain.mockReset();
  mockLatestCheckpoint.mockReset();
  mockRequireCapability.mockReset();
});

function req(): NextRequest {
  return new NextRequest("https://wp.test/api/admin/ogiam/verify", { method: "GET" });
}

describe("GET /api/admin/ogiam/verify", () => {
  test("401 when the capability check denies", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(mockVerifyChain).not.toHaveBeenCalled();
    expect(mockLatestCheckpoint).not.toHaveBeenCalled();
  });

  test("200 with the verification + checkpoint shape, scoped to the workspace", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { id: "u-1", role: "cto", workspaceId: "ws-42" },
      capabilities: new Set(["settings.manage_team"]),
    });
    const verification = {
      ok: true,
      verifiedCount: 12,
      legacyCount: 0,
      brokenAtSeq: null,
      headSeq: 12,
      headHash: "abc",
    };
    const checkpoint = {
      id: "cp-1",
      workspaceId: "ws-42",
      throughSeq: 12,
      headHash: "abc",
      algorithm: "ES256",
      keyId: "vault/keys/ogiam",
      signed: true,
      signedAt: "2026-06-19T00:00:00Z",
      createdAt: "2026-06-19T00:00:00Z",
    };
    mockVerifyChain.mockResolvedValueOnce(verification);
    mockLatestCheckpoint.mockResolvedValueOnce(checkpoint);

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_id).toBe("ws-42");
    expect(body.verification).toEqual(verification);
    expect(body.checkpoint).toEqual(checkpoint);
    // Both reads are scoped to the caller's workspace.
    expect(mockVerifyChain).toHaveBeenCalledWith("ws-42");
    expect(mockLatestCheckpoint).toHaveBeenCalledWith("ws-42");
  });

  test("falls back to the default workspace when the user has none", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { id: "u-1", role: "cto", workspaceId: null },
      capabilities: new Set(["settings.manage_team"]),
    });
    mockVerifyChain.mockResolvedValueOnce({
      ok: true,
      verifiedCount: 0,
      legacyCount: 0,
      brokenAtSeq: null,
      headSeq: 0,
      headHash: null,
    });
    mockLatestCheckpoint.mockResolvedValueOnce(null);

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_id).toBe("default");
    expect(body.checkpoint).toBeNull();
    expect(mockVerifyChain).toHaveBeenCalledWith("default");
  });
});
