/**
 * /api/sites/[id]/share route tests.
 *
 * Pattern mirrors domain-route.test.ts: mock all server deps, import
 * the handlers directly, assemble a NextRequest, inspect the response.
 */

const mockGetUser = jest.fn();
const mockHasRole = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...args: unknown[]) => mockGetUser(...args),
  hasRole: (...args: unknown[]) => mockHasRole(...args),
}));

const mockGetSite = jest.fn();
jest.mock("@/lib/sites", () => ({
  getSiteProject: (...args: unknown[]) => mockGetSite(...args),
}));

const mockIssue = jest.fn();
const mockList = jest.fn();
const mockRevoke = jest.fn();
jest.mock("@/lib/share-tokens", () => ({
  issueShareToken: (...args: unknown[]) => mockIssue(...args),
  listShareTokensForSite: (...args: unknown[]) => mockList(...args),
  revokeShareToken: (...args: unknown[]) => mockRevoke(...args),
}));

const mockLatest = jest.fn();
jest.mock("@/lib/site-approvals", () => ({
  latestApprovalState: (...args: unknown[]) => mockLatest(...args),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import { NextRequest } from "next/server";
import { POST, GET, DELETE } from "@/app/api/sites/[id]/share/route";

function req(
  method: string,
  url = "http://test/api/sites/site_1/share",
  body?: unknown,
  opts: { auth?: string } = {},
) {
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHasRole.mockReturnValue(true);
  mockGetSite.mockResolvedValue({ id: "site_1", client_slug: "acme" });
});

describe("POST /api/sites/[id]/share", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req("POST"), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when site missing", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockGetSite.mockResolvedValueOnce(null);
    const res = await POST(req("POST", undefined, {}, { auth: "Bearer x" }), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when role below sales", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "sales" });
    mockHasRole.mockReturnValueOnce(false);
    const res = await POST(req("POST", undefined, {}, { auth: "Bearer x" }), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(403);
  });

  it("issues a token, returns share URL + metadata, fires analytics", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "dev" });
    mockIssue.mockResolvedValueOnce({
      token: "payload.sig",
      tokenRowId: "row-xyz",
      nonce: "nonce-xyz",
      expiresAt: new Date("2026-05-19T00:00:00Z"),
    });
    const res = await POST(req("POST", undefined, {}, { auth: "Bearer x" }), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBe("payload.sig");
    expect(data.shareUrl).toBe("/share/payload.sig");
    expect(data.nonce).toBe("nonce-xyz");
    expect(mockTrack).toHaveBeenCalledWith(
      "site.share_link_issued",
      "u_1",
      "dev",
      expect.objectContaining({ token_nonce: "nonce-xyz" }),
    );
    // CRITICAL: the signed blob must NEVER land in the analytics metadata.
    const trackedMeta = mockTrack.mock.calls[0][3];
    expect(JSON.stringify(trackedMeta)).not.toContain("payload.sig");
  });

  it("400 on invalid TTL", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "dev" });
    const res = await POST(
      req("POST", undefined, { ttlSeconds: -1 }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("400 on TTL above 90-day cap", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "dev" });
    const res = await POST(
      req("POST", undefined, { ttlSeconds: 10_000_000 }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sites/[id]/share", () => {
  it("lists tokens + the latest approval, excluding the signed blob", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "dev" });
    mockList.mockResolvedValueOnce([
      {
        id: "t1",
        nonce: "n1",
        created_at: "2026-04-19",
        expires_at: "2026-05-19",
        revoked_at: null,
        last_accessed_at: null,
        access_count: 0,
      },
    ]);
    mockLatest.mockResolvedValueOnce({ state: "approved" });
    const res = await GET(req("GET", undefined, undefined, { auth: "Bearer x" }), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tokens).toHaveLength(1);
    // No secret / signed blob exposure:
    expect(Object.keys(data.tokens[0])).not.toContain("token");
    expect(Object.keys(data.tokens[0])).not.toContain("signed");
    expect(data.latestApproval).toEqual({ state: "approved" });
  });

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET(req("GET"), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/sites/[id]/share", () => {
  it("revokes the token by id, fires analytics, 200", async () => {
    mockGetUser.mockReturnValue({ id: "u_99", role: "cto" });
    mockRevoke.mockResolvedValueOnce(undefined);
    const res = await DELETE(
      req(
        "DELETE",
        "http://test/api/sites/site_1/share?tokenId=row-1",
        undefined,
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith("row-1");
    expect(mockTrack).toHaveBeenCalledWith(
      "site.share_link_revoked",
      "u_99",
      "cto",
      expect.objectContaining({ token_id: "row-1" }),
    );
  });

  it("400 without tokenId", async () => {
    mockGetUser.mockReturnValue({ id: "u", role: "dev" });
    const res = await DELETE(
      req("DELETE", "http://test/api/sites/site_1/share", undefined, {
        auth: "Bearer x",
      }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await DELETE(
      req("DELETE", "http://test/api/sites/site_1/share?tokenId=row-1"),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(401);
  });
});
