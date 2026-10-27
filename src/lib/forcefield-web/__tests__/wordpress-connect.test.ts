/** @jest-environment node */
/**
 * WordPress one-click connect: the plugin's secret stored only hashed, the
 * build-phase rule (non-allowlisted address -> review queue, nothing issued),
 * ownership proven ONLY by the challenge served from the site itself (SSRF
 * guard on every hop, redirects only within the site, constant-time compare),
 * exactly one tenant per request, the confirmation email sent on proof, and the
 * site key released exactly once and only after the sign-in link was clicked.
 */
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })), writeQuery: jest.fn() }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: jest.fn(async () => ({ ok: true, remaining: 1 })) }));

import { hashToken } from "@/lib/forcefield-web/tenants";
import {
  startPluginConnect, provePluginConnect, claimPluginToken, fetchPluginChallenge, challengeUrl, isPluginSecret, OWNERSHIP_METHOD,
} from "@/lib/forcefield-web/wordpress-connect";
import { ONBOARDING_WORKSPACE, verificationPlatform } from "@/lib/forcefield-web/onboarding";

const SECRET = `ffp_${"a1".repeat(24)}`;
const allow = async () => ({ allowed: true });
const pass = async () => {};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("isPluginSecret / challengeUrl", () => {
  it("accepts only ffp_ secrets of a safe length and charset", () => {
    expect(isPluginSecret(SECRET)).toBe(true);
    expect(isPluginSecret("ffp_short")).toBe(false);
    expect(isPluginSecret(`ffs_${"a".repeat(40)}`)).toBe(false);
    expect(isPluginSecret(`ffp_${"a".repeat(40)}';--`)).toBe(false);
  });
  it("uses the plain-permalink REST form, which works on every WordPress install", () => {
    expect(challengeUrl("acme.com")).toBe("https://acme.com/?rest_route=%2Fogiam-forcefield%2Fv1%2Fchallenge");
  });
});

describe("startPluginConnect", () => {
  const raw = { site: "https://www.Acme.com/", email: "QA@thewolfpack.agency", secret: SECRET, name: "Acme" };

  it("rejects bad input before any IO", async () => {
    const q = jest.fn();
    for (const bad of [{ ...raw, site: "nope" }, { ...raw, email: "x" }, { ...raw, secret: "abc" }]) {
      expect((await startPluginConnect({ raw: bad, ipHash: "h" }, { q: q as never, limiter: allow })).reason).toBe("invalid");
    }
    expect(q).not.toHaveBeenCalled();
  });

  it("rate limits per IP and per site", async () => {
    const limiter = jest.fn(async (k: string) => ({ allowed: !k.startsWith("site:") }));
    expect((await startPluginConnect({ raw, ipHash: "h" }, { limiter })).reason).toBe("rate_limited");
    expect(limiter.mock.calls.map((c) => c[0]).sort()).toEqual(["ip:h", "site:acme.com"]);
  });

  it("build phase: a non-allowlisted address is filed for review; no row, no challenge", async () => {
    const q = jest.fn();
    const issue = jest.fn();
    const fallback = jest.fn(async () => ({ ok: true, reason: "ok" as const, requestId: "req-r" }));
    const r = await startPluginConnect({ raw: { ...raw, email: "owner@client.example" }, ipHash: "h" }, { q: q as never, limiter: allow, issue, fallbackRequest: fallback as never });
    expect(r).toMatchObject({ ok: true, reason: "request", requestId: "req-r" });
    expect(q).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("stores only the secret's hash and returns the challenge issued in the onboarding workspace", async () => {
    const q = jest.fn(async () => [{ id: "req-1" }]);
    const issue = jest.fn(async () => ({ token: "chal-1" }));
    const r = await startPluginConnect({ raw, ipHash: "h" }, { q: q as never, limiter: allow, issue });
    expect(r).toEqual({ ok: true, reason: "ok", requestId: "req-1", site: "acme.com", challenge: "chal-1" });
    const [sql, params] = q.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("'wordpress'");
    expect(params).toEqual(["Acme", "qa@thewolfpack.agency", "acme.com", "h", hashToken(SECRET)]);
    expect(params).not.toContain(SECRET);
    expect(issue).toHaveBeenCalledWith(ONBOARDING_WORKSPACE, verificationPlatform("req-1"));
  });
});

describe("fetchPluginChallenge", () => {
  it("reads { challenge } from the site through the guard", async () => {
    const guard = jest.fn(pass);
    const fetchImpl = jest.fn(async () => json(200, { challenge: "chal" }));
    expect(await fetchPluginChallenge("acme.com", { fetchImpl: fetchImpl as never, guard })).toEqual({ ok: true, challenge: "chal" });
    expect(guard).toHaveBeenCalledWith(challengeUrl("acme.com"));
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("follows a redirect within the site (www, https) but never off it", async () => {
    const www = jest.fn()
      .mockResolvedValueOnce(new Response("", { status: 301, headers: { location: "https://www.acme.com/?rest_route=/ogiam-forcefield/v1/challenge" } }))
      .mockResolvedValueOnce(json(200, { challenge: "chal" }));
    expect(await fetchPluginChallenge("acme.com", { fetchImpl: www as never, guard: pass })).toEqual({ ok: true, challenge: "chal" });
    const off = jest.fn(async () => new Response("", { status: 302, headers: { location: "https://attacker.example/c" } }));
    expect(await fetchPluginChallenge("acme.com", { fetchImpl: off as never, guard: pass })).toEqual({ ok: false, reason: "redirect_off_site" });
  });

  it("an SSRF refusal, a 404 or a body without a challenge is a coarse failure", async () => {
    expect(await fetchPluginChallenge("acme.com", { fetchImpl: jest.fn() as never, guard: async () => { throw new Error("x"); } })).toEqual({ ok: false, reason: "ssrf_blocked" });
    expect(await fetchPluginChallenge("acme.com", { fetchImpl: (async () => json(404, {})) as never, guard: pass })).toEqual({ ok: false, reason: "http_404" });
    expect(await fetchPluginChallenge("acme.com", { fetchImpl: (async () => json(200, { nope: 1 })) as never, guard: pass })).toEqual({ ok: false, reason: "no_challenge" });
    expect(await fetchPluginChallenge("acme.com", { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never, guard: pass })).toEqual({ ok: false, reason: "fetch_failed" });
  });
});

/** In-memory signup row + tenant for prove/claim. */
function store(over: Record<string, unknown> = {}, notifyStatus: string | null = "pending") {
  const row: Record<string, unknown> = { id: "req-1", name: "Acme", email: "qa@thewolfpack.agency", site_url: "acme.com", status: "pending", tenant_id: null, plugin_linked_at: null, ...over };
  const tenant = { notify_status: notifyStatus };
  const calls: string[] = [];
  const q = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes("WHERE plugin_secret_sha256 = $1")) return params[0] === hashToken(SECRET) ? [{ ...row }] : [];
    if (sql.includes("SET status = 'provisioning'")) {
      if (row.status !== "pending" || row.tenant_id) return [];
      row.status = "provisioning";
      return [{ id: row.id }];
    }
    if (sql.includes("SET status = 'pending'")) { row.status = "pending"; return [{ id: row.id }]; }
    if (sql.includes("SET status = 'approved'")) { Object.assign(row, { status: "approved", tenant_id: params[1], ownership_method: params[2] }); return [{ id: row.id }]; }
    if (sql.includes("UPDATE instinct_target_verifications")) { row.verification = params; return [{ platform: params[1] }]; }
    if (sql.includes("SELECT notify_status FROM forcefield_tenants")) return [tenant];
    if (sql.includes("SET plugin_linked_at = now()")) {
      if (row.plugin_linked_at) return [];
      row.plugin_linked_at = "now";
      return [{ id: row.id }];
    }
    if (sql.includes("SET plugin_linked_at = NULL")) { row.plugin_linked_at = null; return [{ id: row.id }]; }
    return [];
  });
  return { row, tenant, q: q as never, calls };
}
const TENANT = { id: "t1", name: "Acme", siteLabel: "acme.com", status: "active" as const, createdAt: "x", platform: "wordpress" as const };

describe("provePluginConnect", () => {
  const ok = { challenge: async () => "chal", fetchImpl: (async () => json(200, { challenge: "chal" })) as never, guard: pass, limiter: allow };

  it("an unknown or malformed secret proves nothing", async () => {
    const s = store();
    expect((await provePluginConnect(`ffp_${"b2".repeat(24)}`, { ...ok, q: s.q })).reason).toBe("unauthorized");
    expect((await provePluginConnect("nope", { ...ok, q: s.q })).reason).toBe("invalid");
  });

  it("a wrong answer from the site is not_verified and provisions nothing", async () => {
    const s = store();
    const provision = jest.fn();
    const r = await provePluginConnect(SECRET, { ...ok, q: s.q, fetchImpl: (async () => json(200, { challenge: "chaX" })) as never, provision });
    expect(r).toMatchObject({ ok: false, reason: "not_verified", detail: "token_mismatch" });
    expect(provision).not.toHaveBeenCalled();
    expect(s.row.status).toBe("pending");
  });

  it("no challenge issued is not_verified (never a pass on an empty compare)", async () => {
    const s = store();
    const r = await provePluginConnect(SECRET, { ...ok, q: s.q, challenge: async () => null, fetchImpl: (async () => json(200, { challenge: "" })) as never });
    expect(r).toMatchObject({ reason: "not_verified", detail: "no_token_issued" });
  });

  it("the right answer provisions ONE WordPress tenant, records the method, and sends the sign-in email", async () => {
    const s = store();
    const provision = jest.fn(async () => ({ tenant: TENANT, token: "ff_never_handed_out" }));
    const notify = jest.fn(async () => ({ ok: true, reason: "ok" as const, delivered: true }));
    const r = await provePluginConnect(SECRET, { ...ok, q: s.q, provision: provision as never, notify });
    expect(r).toEqual({ ok: true, reason: "ok", requestId: "req-1", tenantId: "t1", site: "acme.com", emailMasked: "qa***@thewolfpack.agency", delivered: true });
    expect(provision).toHaveBeenCalledWith({ name: "Acme", siteLabel: "acme.com", platform: "wordpress" });
    expect(notify).toHaveBeenCalledWith("t1", "qa@thewolfpack.agency");
    expect(s.row).toMatchObject({ status: "approved", tenant_id: "t1", ownership_method: OWNERSHIP_METHOD });
    expect(s.row.verification).toEqual([ONBOARDING_WORKSPACE, verificationPlatform("req-1"), OWNERSHIP_METHOD]);
    expect(JSON.stringify(r)).not.toContain("ff_never_handed_out");
    // A second prove: already verified, nothing provisioned again.
    expect((await provePluginConnect(SECRET, { ...ok, q: s.q, provision: provision as never, notify })).reason).toBe("already_verified");
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("a provisioning failure rolls the claim back", async () => {
    const s = store();
    const r = await provePluginConnect(SECRET, { ...ok, q: s.q, provision: (async () => null) as never });
    expect(r.reason).toBe("provision_failed");
    expect(s.row.status).toBe("pending");
  });

  it("rate limited per request", async () => {
    const s = store();
    expect((await provePluginConnect(SECRET, { ...ok, q: s.q, limiter: async () => ({ allowed: false }) })).reason).toBe("rate_limited");
  });
});

describe("claimPluginToken", () => {
  it("not before ownership is proven, and not before the sign-in link is clicked", async () => {
    expect((await claimPluginToken(SECRET, { q: store().q, limiter: allow })).reason).toBe("not_verified");
    const waiting = store({ status: "approved", tenant_id: "t1" }, "pending");
    const rotate = jest.fn();
    const r = await claimPluginToken(SECRET, { q: waiting.q, limiter: allow, rotate });
    expect(r).toMatchObject({ ok: false, reason: "awaiting_confirmation", emailMasked: "qa***@thewolfpack.agency" });
    expect(r.token).toBeUndefined();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("after confirmation: a fresh key exactly once", async () => {
    const s = store({ status: "approved", tenant_id: "t1" }, "confirmed");
    const rotate = jest.fn(async () => ({ token: "ff_fresh" }));
    const first = await claimPluginToken(SECRET, { q: s.q, limiter: allow, rotate });
    expect(first).toMatchObject({ ok: true, reason: "ok", token: "ff_fresh", tenantId: "t1", site: "acme.com" });
    expect(rotate).toHaveBeenCalledWith("t1");
    const second = await claimPluginToken(SECRET, { q: s.q, limiter: allow, rotate });
    expect(second).toMatchObject({ ok: false, reason: "already_linked" });
    expect(second.token).toBeUndefined();
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it("a rotate failure releases the link so the next poll can retry", async () => {
    const s = store({ status: "approved", tenant_id: "t1" }, "confirmed");
    expect((await claimPluginToken(SECRET, { q: s.q, limiter: allow, rotate: async () => null })).reason).toBe("error");
    expect(s.row.plugin_linked_at).toBeNull();
  });

  it("an unsubscribed or removed address never releases the key", async () => {
    const s = store({ status: "approved", tenant_id: "t1" }, "unsubscribed");
    expect((await claimPluginToken(SECRET, { q: s.q, limiter: allow, rotate: jest.fn() })).reason).toBe("awaiting_confirmation");
  });
});
