/**
 * Contract tests for /api/engineering.
 *
 * Asserts the auth gate (200/401/403), page lookup (200/404), input validation
 * (400), and that the learning + compliance hooks fire (analytics trackEvent +
 * audit recordAudit).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

const mockRecordAudit = jest.fn(async (..._a: unknown[]) => {});
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

const mockListPages = jest.fn();
const mockGetPage = jest.fn();
const mockUpsertPage = jest.fn();
jest.mock("@/lib/engineering", () => ({
  listPages: (...a: unknown[]) => mockListPages(...a),
  getPage: (...a: unknown[]) => mockGetPage(...a),
  upsertPage: (...a: unknown[]) => mockUpsertPage(...a),
}));

import { GET, POST } from "../route";
import { NextResponse } from "next/server";

const USER = { id: "u1", role: "cto" };

function authorize() {
  mockRequireCapability.mockResolvedValue({ ok: true, user: USER });
}
function deny(status: number) {
  mockRequireCapability.mockResolvedValue({
    ok: false,
    response: NextResponse.json({ error: "no" }, { status }),
  });
}

function req(method: string, opts: { slug?: string; body?: unknown } = {}): NextRequest {
  const url = opts.slug
    ? `https://x.test/api/engineering?slug=${encodeURIComponent(opts.slug)}`
    : "https://x.test/api/engineering";
  return new NextRequest(url, {
    method,
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/engineering", () => {
  test("200 returns pages and fires analytics", async () => {
    authorize();
    mockListPages.mockResolvedValue([{ id: "p1", slug: "overview", title: "Overview" }]);
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pages).toHaveLength(1);
    expect(mockTrackEvent).toHaveBeenCalledWith("engineering.viewed", "u1", "cto", expect.any(Object));
  });

  test("200 with ?slug returns the page", async () => {
    authorize();
    mockGetPage.mockResolvedValue({ id: "p1", slug: "overview", title: "Overview" });
    const res = await GET(req("GET", { slug: "overview" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page.slug).toBe("overview");
    expect(mockGetPage).toHaveBeenCalledWith("overview");
    expect(mockListPages).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("404 when ?slug is unknown", async () => {
    authorize();
    mockGetPage.mockResolvedValue(null);
    const res = await GET(req("GET", { slug: "nope" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  test("401 when unauthorized, no analytics", async () => {
    deny(401);
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
    expect(mockListPages).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/engineering", () => {
  const VALID = { slug: "runbooks", title: "Runbooks", body: "# Runbooks" };

  test("201 upserts, fires analytics + audit", async () => {
    authorize();
    mockUpsertPage.mockResolvedValue({ slug: "runbooks", title: "Runbooks", published: true });
    const res = await POST(req("POST", { body: VALID }));
    expect(res.status).toBe(201);
    expect(mockUpsertPage).toHaveBeenCalledTimes(1);
    const passed = mockUpsertPage.mock.calls[0][0] as any;
    expect(passed.createdBy).toBe("u1");
    expect(mockTrackEvent).toHaveBeenCalledWith("engineering.published", "u1", "cto", expect.any(Object));
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audited = mockRecordAudit.mock.calls[0][0] as any;
    expect(audited.action).toBe("engineering.published");
    expect(audited.actor).toEqual({ user_id: "u1", role: "cto" });
    expect(audited.resourceType).toBe("engineering_page");
    expect(audited.resourceId).toBe("runbooks");
  });

  test("403 when lacking engineering.manage", async () => {
    deny(403);
    const res = await POST(req("POST", { body: VALID }));
    expect(res.status).toBe(403);
    expect(mockUpsertPage).not.toHaveBeenCalled();
  });

  test("400 when slug missing", async () => {
    authorize();
    const res = await POST(req("POST", { body: { title: "Runbooks" } }));
    expect(res.status).toBe(400);
    expect(mockUpsertPage).not.toHaveBeenCalled();
  });

  test("400 when title missing", async () => {
    authorize();
    const res = await POST(req("POST", { body: { slug: "runbooks" } }));
    expect(res.status).toBe(400);
    expect(mockUpsertPage).not.toHaveBeenCalled();
  });
});
