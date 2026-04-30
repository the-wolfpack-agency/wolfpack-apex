/* eslint-disable @typescript-eslint/no-explicit-any */
const mockGetCodeBySlug = jest.fn();
const mockRecordScan = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/qr/codes", () => {
  const actual = jest.requireActual("@/lib/qr/codes");
  return {
    ...actual,
    getCodeBySlug: (...a: any[]) => mockGetCodeBySlug(...a),
  };
});
jest.mock("@/lib/qr/scans", () => ({
  recordScan: (...a: any[]) => mockRecordScan(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/q/[slug]/route";

beforeEach(() => {
  mockGetCodeBySlug.mockReset();
  mockRecordScan.mockReset();
  mockTrackEvent.mockReset();
});

function reqFor(slug: string): NextRequest {
  return new NextRequest(`https://wp.test/q/${slug}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (iPhone)",
      "x-forwarded-for": "1.2.3.4",
      "x-vercel-ip-country": "US",
    },
  });
}

describe("GET /q/[slug]", () => {
  test("known active code returns 302 with utm appended", async () => {
    mockGetCodeBySlug.mockResolvedValueOnce({
      id: "code-1",
      slug: "abc1234",
      targetUrl: "https://x.test/page",
      label: null,
      utmCampaign: "spring",
      expiresAt: null,
      archivedAt: null,
      createdAt: "2026-04-30T00:00:00Z",
      createdByUserId: "u1",
      createdByUserRole: "ceo",
    });
    const res = await GET(reqFor("abc1234"), { params: Promise.resolve({ slug: "abc1234" }) });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://x.test/page");
    expect(location).toContain("utm_campaign=spring");
    expect(location).toContain("utm_source=qr");

    expect(mockRecordScan).toHaveBeenCalledWith(
      expect.objectContaining({ codeId: "code-1", blocked: false }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.qr_scan_recorded",
      "u1",
      "public",
      expect.objectContaining({ slug: "abc1234", blocked: false }),
    );
  });

  test("missing slug → /qr-missing redirect, no FK-violating recordScan", async () => {
    mockGetCodeBySlug.mockResolvedValueOnce(null);
    const res = await GET(reqFor("zzz9999"), { params: Promise.resolve({ slug: "zzz9999" }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/qr-missing");

    /* No code id → cannot insert scan row, so recordScan should NOT
       have been called. The analytics event still fires so the
       blocked-attempt count is accurate. */
    expect(mockRecordScan).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.qr_scan_recorded",
      "anonymous",
      "public",
      expect.objectContaining({ blocked: true, reason: "not_found" }),
    );
  });

  test("expired code → /qr-missing redirect + blocked=true scan", async () => {
    mockGetCodeBySlug.mockResolvedValueOnce({
      id: "code-2",
      slug: "exp1234",
      targetUrl: "https://x.test/page",
      label: null,
      utmCampaign: null,
      expiresAt: "2020-01-01T00:00:00Z",
      archivedAt: null,
      createdAt: "2019-01-01T00:00:00Z",
      createdByUserId: "u1",
      createdByUserRole: "ceo",
    });
    const res = await GET(reqFor("exp1234"), { params: Promise.resolve({ slug: "exp1234" }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/qr-missing");
    expect(mockRecordScan).toHaveBeenCalledWith(
      expect.objectContaining({ codeId: "code-2", blocked: true }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.qr_scan_recorded",
      "u1",
      "public",
      expect.objectContaining({ blocked: true, reason: "expired" }),
    );
  });

  test("archived code → /qr-missing redirect + blocked=true scan", async () => {
    mockGetCodeBySlug.mockResolvedValueOnce({
      id: "code-3",
      slug: "arc1234",
      targetUrl: "https://x.test/page",
      label: null,
      utmCampaign: null,
      expiresAt: null,
      archivedAt: "2026-04-29T00:00:00Z",
      createdAt: "2026-04-01T00:00:00Z",
      createdByUserId: "u1",
      createdByUserRole: "ceo",
    });
    const res = await GET(reqFor("arc1234"), { params: Promise.resolve({ slug: "arc1234" }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/qr-missing");
    expect(mockRecordScan).toHaveBeenCalledWith(
      expect.objectContaining({ codeId: "code-3", blocked: true }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.qr_scan_recorded",
      "u1",
      "public",
      expect.objectContaining({ blocked: true, reason: "archived" }),
    );
  });

  test("active code with no campaign omits utm_campaign", async () => {
    mockGetCodeBySlug.mockResolvedValueOnce({
      id: "code-4",
      slug: "noc1234",
      targetUrl: "https://x.test/page",
      label: null,
      utmCampaign: null,
      expiresAt: null,
      archivedAt: null,
      createdAt: "2026-04-30T00:00:00Z",
      createdByUserId: null,
      createdByUserRole: null,
    });
    const res = await GET(reqFor("noc1234"), { params: Promise.resolve({ slug: "noc1234" }) });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("https://x.test/page");
    /* Anonymous user fallback when createdByUserId is null. */
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.qr_scan_recorded",
      "anonymous",
      "public",
      expect.objectContaining({ blocked: false }),
    );
  });
});
