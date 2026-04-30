/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetSnapshotPng = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/bulletin/snapshots", () => ({
  getSnapshotPng: (...a: any[]) => mockGetSnapshotPng(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET } from "../snapshots/[id]/png/route";

beforeEach(() => {
  mockGetSnapshotPng.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(): NextRequest {
  return new NextRequest("https://x.test/api/bulletin/snapshots/snap-1/png", {
    headers: { authorization: "Bearer x" },
  });
}

const tinyPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("GET /api/bulletin/snapshots/[id]/png", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await GET(req(), ctx("snap-1"));
    expect(res.status).toBe(401);
  });

  test("404 when snapshot missing", async () => {
    mockGetSnapshotPng.mockResolvedValueOnce(null);
    const res = await GET(req(), ctx("snap-1"));
    expect(res.status).toBe(404);
  });

  test("200 streams PNG with correct headers + tracks viewed", async () => {
    mockGetSnapshotPng.mockResolvedValueOnce({
      bytes: tinyPng,
      createdAt: "2026-04-30T00:00:00.000Z",
    });
    const res = await GET(req(), ctx("snap-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toMatch(/private, max-age=300/);
    /* Body length matches the byte payload. */
    const ab = await res.arrayBuffer();
    expect(ab.byteLength).toBe(tinyPng.length);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.snapshot_viewed",
      "u1",
      "ceo",
      expect.objectContaining({ snapshot_id: "snap-1" }),
    );
  });
});
