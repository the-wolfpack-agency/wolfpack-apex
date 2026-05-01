/* eslint-disable @typescript-eslint/no-explicit-any */
const mockListScans = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/qr/scans", () => {
  const actual = jest.requireActual("@/lib/qr/scans");
  return {
    ...actual,
    listScans: (...a: any[]) => mockListScans(...a),
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { GET } from "../[id]/scans/route";

beforeEach(() => {
  mockListScans.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

function reqFor(id: string, auth = "Bearer x", limit?: number): NextRequest {
  const url = limit
    ? `https://wp.test/api/qr/${id}/scans?limit=${limit}`
    : `https://wp.test/api/qr/${id}/scans`;
  return new NextRequest(url, {
    headers: { authorization: auth },
  });
}

const sampleScan = {
  id: "scan-1",
  scanned_at: "2026-04-30T12:00:00.000Z",
  visitor_hash: "abc12345xxxxxxxx",
  country: "US",
  region: "CA",
  city: "San Francisco",
  postal_code: "94110",
  latitude: "37.7",
  longitude: "-122.4",
  device: "mobile",
  os: "iOS",
  browser: "Safari",
  language: "en-US",
  timezone_offset_minutes: -480,
  screen_size: "390x844",
  is_bot: false,
  referrer: "https://t.co/x",
  utm_source: "linkedin",
  utm_medium: "social",
  utm_campaign: "spring",
  blocked: false,
  client_id: "client-acme",
  client_match_score: 0.7,
  client_name: "Acme",
};

describe("GET /api/qr/[id]/scans", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const req = reqFor("code-1", "");
    const res = await GET(req, { params: Promise.resolve({ id: "code-1" }) });
    expect(res.status).toBe(401);
  });

  test("400 when id is missing", async () => {
    const req = reqFor("", "Bearer x");
    const res = await GET(req, { params: Promise.resolve({ id: "" }) });
    expect(res.status).toBe(400);
  });

  test("200 returns full scan rows", async () => {
    mockListScans.mockResolvedValueOnce([sampleScan]);
    const req = reqFor("code-1");
    const res = await GET(req, { params: Promise.resolve({ id: "code-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scans).toHaveLength(1);
    expect(body.scans[0]).toEqual(sampleScan);
    /* Tracks the attribution-view event. */
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.qr_scan_detail_viewed",
      "u1",
      "ceo",
      expect.objectContaining({ code_id: "code-1", returned: 1 }),
    );
  });

  test("custom ?limit= is forwarded (capped server-side)", async () => {
    mockListScans.mockResolvedValueOnce([]);
    const req = reqFor("code-1", "Bearer x", 50);
    await GET(req, { params: Promise.resolve({ id: "code-1" }) });
    expect(mockListScans).toHaveBeenCalledWith("code-1", 50);
  });

  test("over-limit ?limit=9999 is clamped to 500", async () => {
    mockListScans.mockResolvedValueOnce([]);
    const req = reqFor("code-1", "Bearer x", 9999);
    await GET(req, { params: Promise.resolve({ id: "code-1" }) });
    expect(mockListScans).toHaveBeenCalledWith("code-1", 500);
  });

  test("returns shape with empty scans list", async () => {
    mockListScans.mockResolvedValueOnce([]);
    const req = reqFor("code-1");
    const res = await GET(req, { params: Promise.resolve({ id: "code-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ scans: [] });
  });
});
