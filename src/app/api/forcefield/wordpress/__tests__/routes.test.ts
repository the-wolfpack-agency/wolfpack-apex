/**
 * @jest-environment node
 *
 * Contract for the PUBLIC WordPress plugin routes:
 *   POST /api/forcefield/wordpress/connect        201 self-serve (challenge) | 202 build-phase request | 400 | 429 | 503
 *   POST /api/forcefield/wordpress/connect/prove  200 | 400 | 401 | 409 | 422 | 429 | 503
 *   POST /api/forcefield/wordpress/connect/claim  200 (key once) | 202 awaiting the link | 400 | 401 | 409 | 422 | 429 | 503
 *   GET  /api/forcefield/wordpress/plugin         200 application/zip
 * Each success is audited and tracked; nothing ever echoes the secret or the
 * challenge into the audit row; never a 500.
 */
import { NextRequest } from "next/server";

const mockStart = jest.fn();
const mockProve = jest.fn();
const mockClaim = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/forcefield-web/wordpress-connect", () => ({
  startPluginConnect: (...a: unknown[]) => mockStart(...a),
  provePluginConnect: (...a: unknown[]) => mockProve(...a),
  claimPluginToken: (...a: unknown[]) => mockClaim(...a),
  CLAIM_WINDOW_MS: 3600_000,
}));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "WordPress/6.8", requestId: "r1" }),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })) }));

import { POST as connect } from "../connect/route";
import { POST as prove } from "../connect/prove/route";
import { POST as claim } from "../connect/claim/route";
import { GET as plugin } from "../plugin/route";

const SECRET = `ffp_${"a1".repeat(24)}`;
const post = (path: string, body: unknown) => new NextRequest(`http://x/api/forcefield/wordpress/${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockAudit.mockResolvedValue(undefined); });

describe("POST /connect", () => {
  const body = { site: "https://acme.com", email: "qa@thewolfpack.agency", secret: SECRET };

  it("400 on a non-object body, without calling the lib", async () => {
    expect((await connect(post("connect", "nope"))).status).toBe(400);
    expect((await connect(post("connect", "[1]"))).status).toBe(400);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("201 with the challenge; audited + tracked without the secret", async () => {
    mockStart.mockResolvedValueOnce({ ok: true, reason: "ok", requestId: "req-1", site: "acme.com", challenge: "chal" });
    const res = await connect(post("connect", body));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, mode: "self_serve", requestId: "req-1", challenge: "chal" });
    expect(mockStart.mock.calls[0][0]).toMatchObject({ raw: body, ipHash: expect.any(String) });
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: "forcefield.wordpress_connect_started", resourceId: "req-1" });
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain("chal");
    expect(mockTrack.mock.calls[0][0]).toBe("forcefield.wordpress_connect_started");
    expect(mockTrack.mock.calls[0][3]).toMatchObject({ email_domain: "thewolfpack.agency", source: "wordpress_plugin" });
  });

  it("202 in the build phase (filed for review), no challenge in the answer", async () => {
    mockStart.mockResolvedValueOnce({ ok: true, reason: "request", requestId: "req-r", site: "client.example" });
    const res = await connect(post("connect", { ...body, email: "owner@client.example" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, mode: "request" });
    expect(mockTrack.mock.calls[0][0]).toBe("forcefield.signup_requested");
  });

  it.each([["invalid", 400], ["rate_limited", 429], ["error", 503]])("%s -> %i", async (reason, status) => {
    mockStart.mockResolvedValueOnce({ ok: false, reason });
    expect((await connect(post("connect", body))).status).toBe(status);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe("POST /connect/prove", () => {
  it("200 verified; audited with the method, never the secret", async () => {
    mockProve.mockResolvedValueOnce({ ok: true, reason: "ok", requestId: "req-1", tenantId: "t1", site: "acme.com", emailMasked: "qa***@thewolfpack.agency", delivered: true });
    const res = await prove(post("connect/prove", { secret: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, emailMasked: "qa***@thewolfpack.agency", delivered: true });
    expect(mockProve).toHaveBeenCalledWith(SECRET);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: "forcefield.wordpress_ownership_verified", afterState: { tenantId: "t1", method: "wordpress_plugin" } });
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(SECRET);
    expect(mockTrack).toHaveBeenCalledWith("forcefield.wordpress_ownership_verified", "anonymous", "public", expect.objectContaining({ confirm_email_delivered: true }));
  });

  it("422 not verified carries the coarse reason and is tracked", async () => {
    mockProve.mockResolvedValueOnce({ ok: false, reason: "not_verified", requestId: "req-1", detail: "token_mismatch" });
    const res = await prove(post("connect/prove", { secret: SECRET }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "not_verified", detail: "token_mismatch" });
    expect(mockTrack).toHaveBeenCalledWith("forcefield.wordpress_ownership_failed", "anonymous", "public", { requestId: "req-1", reason: "token_mismatch" });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it.each([["invalid", 400], ["unauthorized", 401], ["already_verified", 409], ["rate_limited", 429], ["provision_failed", 503], ["error", 503]])("%s -> %i", async (reason, status) => {
    mockProve.mockResolvedValueOnce({ ok: false, reason });
    expect((await prove(post("connect/prove", { secret: SECRET }))).status).toBe(status);
  });

  it("a garbage body is a 400 from the lib's own validation", async () => {
    mockProve.mockResolvedValueOnce({ ok: false, reason: "invalid" });
    expect((await prove(post("connect/prove", "{"))).status).toBe(400);
    expect(mockProve).toHaveBeenCalledWith(undefined);
  });
});

describe("POST /connect/claim", () => {
  it("202 while waiting for the sign-in link, never a key", async () => {
    mockClaim.mockResolvedValueOnce({ ok: false, reason: "awaiting_confirmation", emailMasked: "qa***@thewolfpack.agency" });
    const res = await claim(post("connect/claim", { secret: SECRET }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ ok: false, status: "awaiting_confirmation", emailMasked: "qa***@thewolfpack.agency" });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("200 returns the key once, no-store, audited without it", async () => {
    mockClaim.mockResolvedValueOnce({ ok: true, reason: "ok", requestId: "req-1", tenantId: "t1", site: "acme.com", token: "ff_fresh" });
    const res = await claim(post("connect/claim", { secret: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, token: "ff_fresh", site: "acme.com" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ action: "forcefield.wordpress_linked", resourceId: "t1" });
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain("ff_fresh");
    expect(mockTrack.mock.calls[0][0]).toBe("forcefield.wordpress_linked");
  });

  it.each([["invalid", 400], ["unauthorized", 401], ["already_linked", 409], ["not_verified", 422], ["rate_limited", 429], ["error", 503]])("%s -> %i", async (reason, status) => {
    mockClaim.mockResolvedValueOnce({ ok: false, reason });
    const res = await claim(post("connect/claim", { secret: SECRET }));
    expect(res.status).toBe(status);
    expect((await res.json()).token).toBeUndefined();
  });
});

describe("GET /plugin", () => {
  it("200 serves the installable zip with its version", async () => {
    const res = await plugin();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="ogiam-forcefield.zip"');
    expect(res.headers.get("x-plugin-version")).toMatch(/^\d+\.\d+\.\d+$/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(mockTrack).toHaveBeenCalledWith("forcefield.wordpress_plugin_downloaded", "anonymous", "public", { version: res.headers.get("x-plugin-version") });
  });
});
