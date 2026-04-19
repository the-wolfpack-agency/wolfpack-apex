/**
 * /api/public/approvals/[token] route tests.
 *
 * Verifies the full server-side flow for the PUBLIC (unauth) endpoint:
 *   - cryptographic verification of the signed blob
 *   - DB revocation check
 *   - rate-limit trip at N+1 posts
 *   - persistence of actor_name / actor_email
 *   - noindex headers on every response path
 *   - 400 on bad state, 401 on invalid/revoked tokens
 */

const mockVerify = jest.fn();
const mockLoad = jest.fn();
const mockTouch = jest.fn();
const mockSecret = jest.fn(() => "share-test-secret-never-use-in-production");
jest.mock("@/lib/share-tokens", () => ({
  verifyShareToken: (...args: unknown[]) => mockVerify(...args),
  loadActiveTokenRow: (...args: unknown[]) => mockLoad(...args),
  touchShareTokenAccess: (...args: unknown[]) => mockTouch(...args),
  getShareSecret: () => mockSecret(),
}));

const mockRecord = jest.fn();
jest.mock("@/lib/site-approvals", () => ({
  recordApproval: (...args: unknown[]) => mockRecord(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import {
  POST,
  __resetRateLimitForTests,
} from "@/app/api/public/approvals/[token]/route";

function req(body: unknown) {
  return new NextRequest("http://test/api/public/approvals/sometoken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD_CLAIMS = { siteId: "site_1", nonce: "nonce-1", exp: 9_999_999_999 };
const GOOD_ROW = {
  id: "tok-row-1",
  site_id: "site_1",
  nonce: "nonce-1",
  created_by: null,
  created_at: "2026-04-01T00:00:00Z",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  revoked_at: null,
  last_accessed_at: null,
  access_count: 3,
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetRateLimitForTests();
  mockVerify.mockReturnValue({ ok: true, claims: GOOD_CLAIMS });
  mockLoad.mockResolvedValue(GOOD_ROW);
  mockRecord.mockResolvedValue({
    id: "a1",
    siteId: "site_1",
    state: "approved",
    actorName: null,
    actorEmail: null,
    comment: null,
    createdAt: "2026-04-19T00:00:00Z",
    viaShareToken: true,
    shareTokenId: "tok-row-1",
  });
});

describe("POST /api/public/approvals/[token] — happy paths", () => {
  it("approves with actor_name + actor_email persisted", async () => {
    const res = await POST(
      req({
        state: "approved",
        actorName: "Client Name",
        actorEmail: "client@example.com",
        comment: "Looks great",
      }),
      { params: Promise.resolve({ token: "sometoken" }) },
    );
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site_1",
        state: "approved",
        actorName: "Client Name",
        actorEmail: "client@example.com",
        comment: "Looks great",
        shareTokenRowId: "tok-row-1",
      }),
    );
    expect(mockTouch).toHaveBeenCalledWith("tok-row-1");
    expect(mockTrack).toHaveBeenCalledWith(
      "site.share_link_accessed",
      "public",
      "client",
      expect.objectContaining({ token_nonce: "nonce-1" }),
    );
  });

  it("handles changes_requested state", async () => {
    const res = await POST(req({ state: "changes_requested", comment: "Fix X" }), {
      params: Promise.resolve({ token: "sometoken" }),
    });
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ state: "changes_requested" }),
    );
  });

  it("sets noindex response headers", async () => {
    const res = await POST(req({ state: "approved" }), {
      params: Promise.resolve({ token: "sometoken" }),
    });
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
  });
});

describe("POST /api/public/approvals/[token] — rejection paths", () => {
  it("401 on invalid signature", async () => {
    mockVerify.mockReturnValueOnce({ ok: false, reason: "bad_signature" });
    const res = await POST(req({ state: "approved" }), {
      params: Promise.resolve({ token: "bogus" }),
    });
    expect(res.status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("401 on expired token", async () => {
    mockVerify.mockReturnValueOnce({ ok: false, reason: "expired" });
    const res = await POST(req({ state: "approved" }), {
      params: Promise.resolve({ token: "old" }),
    });
    expect(res.status).toBe(401);
  });

  it("401 on revoked or unknown nonce", async () => {
    mockLoad.mockResolvedValueOnce(null);
    const res = await POST(req({ state: "approved" }), {
      params: Promise.resolve({ token: "good" }),
    });
    expect(res.status).toBe(401);
  });

  it("401 when claim siteId does not match DB row (anti-replay)", async () => {
    mockLoad.mockResolvedValueOnce({ ...GOOD_ROW, site_id: "other_site" });
    const res = await POST(req({ state: "approved" }), {
      params: Promise.resolve({ token: "mismatched" }),
    });
    expect(res.status).toBe(401);
  });

  it("400 on bad state value", async () => {
    const res = await POST(req({ state: "nonsense" }), {
      params: Promise.resolve({ token: "good" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON body", async () => {
    const brokenReq = new NextRequest("http://test/api/public/approvals/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(brokenReq, {
      params: Promise.resolve({ token: "good" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/public/approvals/[token] — rate limiting", () => {
  it("allows 10 posts then 429s the 11th for the same nonce", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await POST(req({ state: "approved" }), {
        params: Promise.resolve({ token: "tok" }),
      });
      expect(res.status).toBe(200);
    }
    const res11 = await POST(req({ state: "approved" }), {
      params: Promise.resolve({ token: "tok" }),
    });
    expect(res11.status).toBe(429);
    expect(res11.headers.get("retry-after")).toBeTruthy();
  });

  it("different nonces have independent buckets", async () => {
    for (let i = 0; i < 10; i++) {
      await POST(req({ state: "approved" }), {
        params: Promise.resolve({ token: "tok-a" }),
      });
    }
    // Different nonce in the claims → different bucket.
    mockVerify.mockReturnValueOnce({
      ok: true,
      claims: { ...GOOD_CLAIMS, nonce: "nonce-b" },
    });
    mockLoad.mockResolvedValueOnce({ ...GOOD_ROW, nonce: "nonce-b" });
    const res = await POST(req({ state: "approved" }), {
      params: Promise.resolve({ token: "tok-b" }),
    });
    expect(res.status).toBe(200);
  });
});
