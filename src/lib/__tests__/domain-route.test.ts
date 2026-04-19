/**
 * /api/sites/[id]/domain route tests.
 *
 * Pattern mirrors brief-edit-route.test.ts — jest.mock all server deps,
 * import the route handlers directly, assemble a NextRequest, inspect
 * the NextResponse status + JSON body.
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

const mockRegister = jest.fn();
const mockRefresh = jest.fn();
const mockUnregister = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/site-domains", () => ({
  registerDomain: (...args: unknown[]) => mockRegister(...args),
  refreshDomainStatus: (...args: unknown[]) => mockRefresh(...args),
  unregisterDomain: (...args: unknown[]) => mockUnregister(...args),
  listDomainsForSite: (...args: unknown[]) => mockList(...args),
}));

import { NextRequest } from "next/server";
import {
  POST,
  GET,
  PATCH,
  DELETE,
} from "@/app/api/sites/[id]/domain/route";
import { VercelDomainError } from "@/lib/sites-domain";

function req(
  method: string,
  url = "http://test/api/sites/site_1/domain",
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

describe("POST /api/sites/[id]/domain", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await POST(req("POST", undefined, { domain: "acme.com" }), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when site missing", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockGetSite.mockResolvedValueOnce(null);
    const res = await POST(
      req("POST", undefined, { domain: "acme.com" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("403 when role below sales", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockHasRole.mockReturnValueOnce(false);
    const res = await POST(
      req("POST", undefined, { domain: "acme.com" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(403);
  });

  it("400 on missing domain", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await POST(
      req("POST", undefined, {}, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("400 on invalid JSON", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const bad = new NextRequest("http://test/api/sites/site_1/domain", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer x",
      },
      body: "{ not json",
    });
    const res = await POST(bad, { params: Promise.resolve({ id: "site_1" }) });
    expect(res.status).toBe(400);
  });

  it("200 happy path returns verification block", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockRegister.mockResolvedValueOnce({
      id: "d_1",
      domain: "acme.com",
      status: "pending",
      verification_records: [
        { type: "TXT", domain: "_vercel.acme.com", value: "vc-1" },
      ],
    });
    const res = await POST(
      req("POST", undefined, { domain: "acme.com" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.domain).toBe("acme.com");
    expect(data.status).toBe("pending");
    expect(data.verification).toHaveLength(1);
  });

  it("409 when domain already in use (VercelDomainError)", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockRegister.mockRejectedValueOnce(
      new VercelDomainError("domain_in_use", 409, "taken"),
    );
    const res = await POST(
      req("POST", undefined, { domain: "acme.com" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.reason).toBe("domain_in_use");
  });

  it("409 on Postgres unique violation", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const pgErr = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "apex_site_domains_domain_uniq",
    });
    mockRegister.mockRejectedValueOnce(pgErr);
    const res = await POST(
      req("POST", undefined, { domain: "acme.com" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(409);
  });

  it("400 when register throws domain_invalid", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockRegister.mockRejectedValueOnce(
      new VercelDomainError("domain_invalid", 400, "bad"),
    );
    const res = await POST(
      req("POST", undefined, { domain: "bogus" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("429 when Vercel rate-limits", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockRegister.mockRejectedValueOnce(
      new VercelDomainError("rate_limited", 429, "slow"),
    );
    const res = await POST(
      req("POST", undefined, { domain: "acme.com" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(429);
  });
});

describe("GET /api/sites/[id]/domain", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const res = await GET(req("GET"), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns domains array", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockList.mockResolvedValueOnce([
      { domain: "acme.com", status: "verified" },
    ]);
    const res = await GET(req("GET", undefined, undefined, { auth: "Bearer x" }), {
      params: Promise.resolve({ id: "site_1" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.domains).toHaveLength(1);
  });
});

describe("PATCH /api/sites/[id]/domain", () => {
  it("400 unsupported action", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await PATCH(
      req("PATCH", undefined, { domain: "acme.com", action: "bogus" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("refresh happy path", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockRefresh.mockResolvedValueOnce({
      domain: "acme.com",
      status: "verified",
      verification_records: [],
    });
    const res = await PATCH(
      req("PATCH", undefined, { domain: "acme.com", action: "refresh" }, { auth: "Bearer x" }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.record.status).toBe("verified");
  });
});

describe("DELETE /api/sites/[id]/domain", () => {
  it("400 without domain query param", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    const res = await DELETE(
      req("DELETE", "http://test/api/sites/site_1/domain", undefined, {
        auth: "Bearer x",
      }),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("happy path 200", async () => {
    mockGetUser.mockReturnValue({ id: "u_1", role: "sales" });
    mockUnregister.mockResolvedValueOnce(undefined);
    const res = await DELETE(
      req(
        "DELETE",
        "http://test/api/sites/site_1/domain?domain=acme.com",
        undefined,
        { auth: "Bearer x" },
      ),
      { params: Promise.resolve({ id: "site_1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockUnregister).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site_1", domain: "acme.com" }),
    );
  });
});
