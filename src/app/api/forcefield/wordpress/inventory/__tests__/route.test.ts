/**
 * @jest-environment node
 *
 * Contract for POST /api/forcefield/wordpress/inventory (the plugin's server
 * report) and GET /api/forcefield/my-exposure (the dashboard panel):
 *   inventory: 200 | 400 bad payload | 401 no/unknown key | 403 dashboard
 *              session (read-only) | 413 | 429 | 503; audited + tracked.
 *   my-exposure: 200 (report or null) | 401 | 503.
 * The lib runs for real (validation, matching); only the DB, the credential
 * resolver, the rate limiter, audit and analytics are stubbed.
 */
import { NextRequest } from "next/server";

const mockResolve = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
const mockLimit = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/forcefield-web/dashboard-session", () => ({ resolveTenantCredential: (...a: unknown[]) => mockResolve(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "WordPress/6.8", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a), trackEventAwait: jest.fn(async () => {}) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => mockLimit(...a) }));
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a), safeQuery: jest.fn() }));
jest.mock("@/lib/forcefield-web/tenant-notify", () => ({
  getNotifyState: jest.fn(async () => null),
  mintUnsubscribeToken: () => "tok",
}));

import { POST } from "../route";
import { GET } from "../../../my-exposure/route";

const TENANT = { id: "11111111-1111-4111-8111-111111111111", name: "Acme", siteLabel: "acme.example", status: "active", createdAt: "" };
const BODY = { phpVersion: "8.3.10", wordpressVersion: "6.8.3", serverSoftware: "Apache/2.4.62", plugins: [{ slug: "akismet", version: "5.3" }], pluginVersion: "0.4.0" };
const post = (body: unknown, key = "ff_site_key") =>
  new NextRequest("http://x/api/forcefield/wordpress/inventory", {
    method: "POST",
    headers: key ? { "x-edge-token": key, "content-type": "application/json" } : { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue({ tenant: TENANT, via: "ingest" });
  mockLimit.mockResolvedValue({ ok: true, remaining: 10 });
  mockAudit.mockResolvedValue(undefined);
  mockQuery.mockResolvedValue({ rows: [{ alerted_keys: [], reports: 1 }] });
});

describe("POST /api/forcefield/wordpress/inventory", () => {
  it("200 with the status; stored, audited and tracked (inventory + new exposure)", async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "exposed", exposed: 1, unknown: 0 });
    expect(mockResolve).toHaveBeenCalledWith("ff_site_key");
    expect(String(mockQuery.mock.calls[0][0])).toContain("INSERT INTO forcefield_server_inventory");
    expect(mockAudit.mock.calls.map((c) => c[0].action)).toEqual(["forcefield.server_inventory_received", "forcefield.server_exposure_found"]);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ resourceId: TENANT.id, afterState: { status: "exposed", exposed: ["php2shell:php"], phpLine: "8.3" } });
    expect(mockTrack.mock.calls.map((c) => c[0])).toEqual(["forcefield.server_inventory_received", "forcefield.server_exposure_found"]);
    expect(mockTrack.mock.calls[0][3]).toMatchObject({ tenant_id: TENANT.id, status: "exposed", php_line: "8.3", exposed: 1, plugins: 1 });
    expect(mockTrack.mock.calls[1][3]).toMatchObject({ rule: "php2shell", product: "php", installed: "8.3.10", fixed: "8.3.36", cve: "CVE-2026-109618,CVE-2026-109619", alert: "not_confirmed" });
  });

  it("200 up to date: no exposure event", async () => {
    const res = await POST(post({ ...BODY, phpVersion: "8.4.27" }));
    expect(await res.json()).toEqual({ ok: true, status: "ok", exposed: 0, unknown: 0 });
    expect(mockTrack.mock.calls.map((c) => c[0])).toEqual(["forcefield.server_inventory_received"]);
  });

  it("401 with no key or an unknown key, before reading the body", async () => {
    mockResolve.mockResolvedValueOnce(null);
    expect((await POST(post(BODY, ""))).status).toBe(401);
    mockResolve.mockResolvedValueOnce(null);
    const res = await POST(post(BODY, "ff_unknown"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("403 for a dashboard session: it can read the dashboard but cannot report for the site", async () => {
    mockResolve.mockResolvedValueOnce({ tenant: TENANT, via: "session" });
    const res = await POST(post(BODY, "eyJsession"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "site_key_required" });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", [BODY]],
    ["an unknown field", { ...BODY, users: ["admin"] }],
    ["a bad plugin entry", { ...BODY, plugins: [{ slug: "../x", version: "1" }] }],
    ["no versions", { plugins: [] }],
  ])("400 on %s, never stored", async (_l, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("413 on an oversize body", async () => {
    const res = await POST(post({ ...BODY, serverSoftware: "A".repeat(70_000) }));
    expect(res.status).toBe(413);
  });

  it("429 when the per-tenant limit is spent", async () => {
    mockLimit.mockResolvedValueOnce({ ok: false, remaining: 0 });
    const res = await POST(post(BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
  });

  it("503 when the database is down (never 500)", async () => {
    mockQuery.mockRejectedValueOnce(new Error("down"));
    expect((await POST(post(BODY))).status).toBe(503);
  });
});

describe("GET /api/forcefield/my-exposure", () => {
  const get = (token = "ff_site_key") => new NextRequest("http://x/api/forcefield/my-exposure", { headers: token ? { "x-forcefield-token": token } : {} });

  it("401 without a recognized credential", async () => {
    mockResolve.mockResolvedValueOnce(null);
    const res = await GET(get(""));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("200 with report null before the first inventory", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, report: null });
  });

  it("200 with the computed report, for a dashboard session too, scoped to the resolved tenant", async () => {
    mockResolve.mockResolvedValueOnce({ tenant: TENANT, via: "session" });
    mockQuery.mockResolvedValueOnce({ rows: [{ php_version: "8.4.27", wordpress_version: "6.8.3", server_software: "nginx", plugins: [], plugin_version: "0.4.0", alerted_keys: [], reports: 2, first_received_at: "a", received_at: "b" }] });
    const res = await GET(get("eyJsession"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report).toMatchObject({ status: "ok", phpVersion: "8.4.27", receivedAt: "b" });
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT.id]);
  });

  it("503 when the read fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("down"));
    expect((await GET(get())).status).toBe(503);
  });
});
