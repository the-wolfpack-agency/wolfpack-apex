 
const mockGetSnapshotPng = jest.fn();
const mockTrackEvent = jest.fn();
const mockGetUserFromRequest = jest.fn();
const mockVerifyToken = jest.fn();
const mockCookiesGet = jest.fn();

jest.mock("@/lib/bulletin/snapshots", () => ({
  getSnapshotPng: (...a: any[]) => mockGetSnapshotPng(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUserFromRequest(...a),
  verifyToken: (...a: any[]) => mockVerifyToken(...a),
}));
jest.mock("@/lib/crypto/cookies", () => ({
  ACCESS_TOKEN_COOKIE: "instinct_access_token",
}));
jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => mockCookiesGet(name),
  }),
}));

import { NextRequest } from "next/server";
import { GET } from "../snapshots/[id]/png/route";

beforeEach(() => {
  mockGetSnapshotPng.mockReset();
  mockTrackEvent.mockReset();
  mockGetUserFromRequest.mockReset();
  mockVerifyToken.mockReset();
  mockCookiesGet.mockReset();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function reqWithBearer(): NextRequest {
  return new NextRequest("https://x.test/api/bulletin/snapshots/snap-1/png", {
    headers: { authorization: "Bearer x" },
  });
}

function reqNoHeader(): NextRequest {
  return new NextRequest("https://x.test/api/bulletin/snapshots/snap-1/png");
}

const tinyPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("GET /api/bulletin/snapshots/[id]/png", () => {
  test("401 when neither header nor cookie auth resolves", async () => {
    mockGetUserFromRequest.mockReturnValue(null);
    mockCookiesGet.mockReturnValue(undefined);
    const res = await GET(reqNoHeader(), ctx("snap-1"));
    expect(res.status).toBe(401);
  });

  test("404 when snapshot missing (Bearer auth)", async () => {
    mockGetUserFromRequest.mockReturnValue({
      id: "u1",
      role: "ceo",
      name: "Nick",
      email: "n@x.co",
    });
    mockGetSnapshotPng.mockResolvedValueOnce(null);
    const res = await GET(reqWithBearer(), ctx("snap-1"));
    expect(res.status).toBe(404);
  });

  test("200 streams PNG with Bearer header auth + tracks viewed", async () => {
    mockGetUserFromRequest.mockReturnValue({
      id: "u1",
      role: "ceo",
      name: "Nick",
      email: "n@x.co",
    });
    mockGetSnapshotPng.mockResolvedValueOnce({
      bytes: tinyPng,
      createdAt: "2026-04-30T00:00:00.000Z",
    });
    const res = await GET(reqWithBearer(), ctx("snap-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toMatch(/private, max-age=300/);
    const ab = await res.arrayBuffer();
    expect(ab.byteLength).toBe(tinyPng.length);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.snapshot_viewed",
      "u1",
      "ceo",
      expect.objectContaining({ snapshot_id: "snap-1" }),
    );
  });

  /* Regression 2026-05-02: top-level browser navigation from the
     snapshot's "Download" / "View" anchor doesn't carry the
     Authorization header — only cookies. Without a cookie fallback
     the route 401'd, the browser dropped the response, and the
     download tray showed "File wasn't available on site." */
  test("200 streams PNG via instinct_access_token cookie when no Bearer header is present", async () => {
    mockGetUserFromRequest.mockReturnValue(null);
    mockCookiesGet.mockImplementation((n: string) =>
      n === "instinct_access_token" ? { value: "cookie-token" } : undefined,
    );
    mockVerifyToken.mockReturnValue({
      userId: "u-cookie",
      email: "cookie@x.co",
      name: "Cookie User",
      role: "ceo",
    });
    mockGetSnapshotPng.mockResolvedValueOnce({
      bytes: tinyPng,
      createdAt: "2026-04-30T00:00:00.000Z",
    });

    const res = await GET(reqNoHeader(), ctx("snap-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");

    /* Analytics still fires under the cookie-resolved identity. */
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "bulletin.snapshot_viewed",
      "u-cookie",
      "ceo",
      expect.objectContaining({ snapshot_id: "snap-1" }),
    );
  });

  test("401 when cookie token verification throws", async () => {
    mockGetUserFromRequest.mockReturnValue(null);
    mockCookiesGet.mockReturnValue({ value: "garbage" });
    mockVerifyToken.mockImplementation(() => {
      throw new Error("bad sig");
    });
    const res = await GET(reqNoHeader(), ctx("snap-1"));
    expect(res.status).toBe(401);
  });
});
