/* eslint-disable @typescript-eslint/no-explicit-any */
const mockCreateCode = jest.fn();
const mockListCodes = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/qr/codes", () => {
  const actual = jest.requireActual("@/lib/qr/codes");
  return {
    ...actual,
    createCode: (...a: any[]) => mockCreateCode(...a),
    listCodes: (...a: any[]) => mockListCodes(...a),
  };
});
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { POST, GET } from "../route";

beforeEach(() => {
  mockCreateCode.mockReset();
  mockListCodes.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

const sampleCode = {
  id: "code-1",
  slug: "abc1234",
  targetUrl: "https://x.test/page",
  label: "Demo",
  utmCampaign: "spring",
  expiresAt: null,
  archivedAt: null,
  createdAt: "2026-04-30T00:00:00.000Z",
  createdByUserId: "u1",
  createdByUserRole: "ceo",
};

function postBody(body: unknown, auth = "Bearer x"): NextRequest {
  return new NextRequest("https://x.test/api/qr", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/qr", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await POST(postBody({ targetUrl: "https://x.test" }));
    expect(res.status).toBe(401);
  });

  test("400 on invalid URL", async () => {
    const res = await POST(postBody({ targetUrl: "javascript:alert(1)" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/http or https/);
  });

  test("400 when targetUrl missing", async () => {
    const res = await POST(postBody({ label: "x" }));
    expect(res.status).toBe(400);
  });

  test("200 happy path returns code, qrSvg, shortUrl, fullRedirectUrl", async () => {
    mockCreateCode.mockResolvedValueOnce(sampleCode);
    process.env.NEXT_PUBLIC_BASE_URL = "https://wolfpack-instinct.vercel.app";

    const res = await POST(
      postBody({
        targetUrl: "https://x.test/page",
        label: "Demo",
        utmCampaign: "spring",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code.slug).toBe("abc1234");
    expect(body.shortUrl).toBe("/q/abc1234");
    expect(body.fullRedirectUrl).toBe(
      "https://wolfpack-instinct.vercel.app/q/abc1234",
    );
    expect(typeof body.qrSvg).toBe("string");
    expect(body.qrSvg.startsWith("<svg")).toBe(true);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.qr_code_created",
      "u1",
      "ceo",
      expect.objectContaining({
        slug: "abc1234",
        has_utm: true,
        has_expiry: false,
        target_host: "x.test",
      }),
    );
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  test("500 when createCode throws non-validation error", async () => {
    mockCreateCode.mockRejectedValueOnce(new Error("DB down"));
    const res = await POST(postBody({ targetUrl: "https://x.test/page" }));
    expect(res.status).toBe(500);
  });
});

describe("GET /api/qr", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const req = new NextRequest("https://x.test/api/qr", {
      headers: { authorization: "" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  test("returns codes from listCodes", async () => {
    mockListCodes.mockResolvedValueOnce([sampleCode]);
    const req = new NextRequest("https://x.test/api/qr", {
      headers: { authorization: "Bearer x" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.codes).toHaveLength(1);
    expect(body.codes[0].slug).toBe("abc1234");
  });

  test("?mine=true scopes by userId", async () => {
    mockListCodes.mockResolvedValueOnce([]);
    const req = new NextRequest("https://x.test/api/qr?mine=true", {
      headers: { authorization: "Bearer x" },
    });
    await GET(req);
    expect(mockListCodes).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1" }),
    );
  });
});
