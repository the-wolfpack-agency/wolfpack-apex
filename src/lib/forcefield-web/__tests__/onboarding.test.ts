/** @jest-environment node */
/**
 * Self-serve onboarding lib: the build-phase fallback (a non-allowlisted address
 * goes to the reviewed queue, gets no setup key, nothing is sent), the setup key
 * stored only as a hash, the ownership challenge issued through the platform-scan
 * verification, one-click verification over both methods, exactly one tenant per
 * request (claim), provisioning failure rollback, and the concierge request.
 */
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })), writeQuery: jest.fn() }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: jest.fn(async () => ({ ok: true, remaining: 1 })) }));

import { hashToken } from "@/lib/forcefield-web/tenants";
import {
  startForcefieldOnboarding, verifyOwnership, getOnboardingState, requestConcierge, ownershipInstructions, validateOnboarding,
  ONBOARDING_WORKSPACE, verificationPlatform, NO_CODE_CONNECT,
} from "@/lib/forcefield-web/onboarding";

const allow = async () => ({ allowed: true });

describe("validateOnboarding", () => {
  it("normalizes the site and email; name defaults to the site", () => {
    expect(validateOnboarding({ siteUrl: "https://www.Acme.com/path", email: " QA@thewolfpack.agency " })).toEqual({ site: "acme.com", email: "qa@thewolfpack.agency", name: "acme.com" });
    expect(validateOnboarding({ siteUrl: "acme", email: "qa@thewolfpack.agency" })).toBeNull();
    expect(validateOnboarding({ siteUrl: "acme.com", email: "nope" })).toBeNull();
  });
});

describe("startForcefieldOnboarding", () => {
  it("honeypot, rate limit and invalid input short-circuit", async () => {
    const q = jest.fn();
    expect((await startForcefieldOnboarding({ raw: { _hp_company: "x" }, ipHash: "h" }, { q: q as never, limiter: allow })).reason).toBe("honeypot");
    expect((await startForcefieldOnboarding({ raw: { siteUrl: "a.com", email: "a@thewolfpack.agency" }, ipHash: "h" }, { q: q as never, limiter: async () => ({ allowed: false }) })).reason).toBe("rate_limited");
    expect((await startForcefieldOnboarding({ raw: { siteUrl: "x", email: "a" }, ipHash: "h" }, { q: q as never, limiter: allow })).reason).toBe("invalid");
    expect(q).not.toHaveBeenCalled();
  });

  it("build phase: a non-allowlisted address is filed for review, no setup key, no challenge", async () => {
    const fallback = jest.fn(async () => ({ ok: true, reason: "ok" as const, requestId: "req-9" }));
    const issue = jest.fn();
    const q = jest.fn();
    const r = await startForcefieldOnboarding({ raw: { siteUrl: "client.example", email: "owner@client.example" }, ipHash: "h" }, { q: q as never, limiter: allow, fallbackRequest: fallback as never, issue });
    expect(r).toEqual({ ok: true, reason: "request", requestId: "req-9" });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect((fallback.mock.calls[0] as unknown[])[0]).toMatchObject({ raw: { email: "owner@client.example", siteUrl: "client.example" } });
    expect(issue).not.toHaveBeenCalled();
    expect(q).not.toHaveBeenCalled();
  });

  it("self-serve: inserts with only the key hash and issues the challenge in the onboarding workspace", async () => {
    const q = jest.fn(async () => [{ id: "req-1" }]);
    const issue = jest.fn(async () => ({ token: "chal" }));
    const r = await startForcefieldOnboarding({ raw: { siteUrl: "acme.com", email: "qa@thewolfpack.agency" }, ipHash: "h" }, { q: q as never, limiter: allow, issue });
    expect(r.reason).toBe("ok");
    expect(r.setupKey).toMatch(/^ffs_/);
    const params = (q.mock.calls[0] as unknown[])[1] as unknown[];
    expect(params[5]).toBe(hashToken(r.setupKey!));
    expect(params).not.toContain(r.setupKey);
    expect(issue).toHaveBeenCalledWith(ONBOARDING_WORKSPACE, verificationPlatform("req-1"));
    expect(r.ownership).toEqual(ownershipInstructions("acme.com", "chal"));
    expect(r.ownership![0]).toMatchObject({ method: "dns_txt", location: "acme.com", value: "ogiam-site-verification=chal" });
    expect(r.ownership![1]).toMatchObject({ method: "http_well_known", location: "https://acme.com/.well-known/ogiam-site-verification.txt", value: "chal" });
  });

  it("a store error is 'error', not a throw", async () => {
    const q = jest.fn(async () => { throw new Error("down"); });
    expect((await startForcefieldOnboarding({ raw: { siteUrl: "acme.com", email: "qa@thewolfpack.agency" }, ipHash: "h" }, { q: q as never, limiter: allow, issue: async () => ({ token: "t" }) })).reason).toBe("error");
  });
});

/** An in-memory forcefield_signup_requests row for verify/state. */
function store(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { id: "req-1", name: "acme.com", email: "qa@thewolfpack.agency", site_url: "acme.com", status: "pending", tenant_id: null, ownership_method: null, ownership_verified_at: null, concierge_requested_at: null, ...over };
  const key = "ffs_key";
  const q = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM forcefield_signup_requests") && sql.includes("setup_key_sha256 = $1")) return params[0] === hashToken(key) ? [{ ...row }] : [];
    if (sql.includes("FROM instinct_target_verifications")) return [{ verification_token: "chal" }];
    if (sql.includes("SET status = 'provisioning'")) {
      if (row.status !== "pending" || row.tenant_id) return [];
      row.status = "provisioning";
      return [{ id: row.id }];
    }
    if (sql.includes("SET status = 'pending'")) { row.status = "pending"; return [{ id: row.id }]; }
    if (sql.includes("SET status = 'approved'")) { Object.assign(row, { status: "approved", tenant_id: params[1], ownership_method: params[2], ownership_verified_at: "now" }); return [{ id: row.id }]; }
    if (sql.includes("concierge_requested_at = COALESCE")) { row.concierge_requested_at = "now"; return [{ id: row.id }]; }
    return [];
  });
  return { row, key, q: q as never };
}
const tenant = { id: "t1", name: "acme.com", siteLabel: "acme.com", status: "active" as const, createdAt: "x", platform: "generic" as const };

describe("verifyOwnership", () => {
  it("unknown key is unauthorized", async () => {
    const s = store();
    expect((await verifyOwnership("ffs_other", { q: s.q, limiter: allow })).reason).toBe("unauthorized");
    expect((await verifyOwnership("not-a-key", { q: s.q, limiter: allow })).reason).toBe("unauthorized");
  });

  it("not verified: both methods tried against https://<site>, reasons returned, no tenant", async () => {
    const s = store();
    const check = jest.fn(async (_ws: string, _p: string, method: string, _a: unknown, deps: { resolveBaseUrl: () => Promise<string> }) => {
      expect(await deps.resolveBaseUrl()).toBe("https://acme.com");
      return { ok: false, reason: method === "dns_txt" ? "no_txt_record" : "http_404" };
    });
    const provision = jest.fn();
    const r = await verifyOwnership(s.key, { q: s.q, limiter: allow, check: check as never, provision });
    expect(r.reason).toBe("not_verified");
    expect(r.attempts).toEqual([{ method: "dns_txt", reason: "no_txt_record" }, { method: "http_well_known", reason: "http_404" }]);
    expect(check.mock.calls.map((c) => [c[0], c[1]])).toEqual([[ONBOARDING_WORKSPACE, "ff-signup:req-1"], [ONBOARDING_WORKSPACE, "ff-signup:req-1"]]);
    expect(provision).not.toHaveBeenCalled();
    expect(s.row.status).toBe("pending");
  });

  it("verified by the file: provisions ONE tenant, returns the token once, sends the confirmation", async () => {
    const s = store();
    const check = jest.fn(async (_ws: string, _p: string, method: string) => ({ ok: method === "http_well_known", reason: "no_txt_record" }));
    const provision = jest.fn(async () => ({ tenant, token: "ff_tok" }));
    const notify = jest.fn(async () => ({ ok: true, reason: "ok" as const, delivered: true, deliveryReason: "ok" }));
    const r = await verifyOwnership(s.key, { q: s.q, limiter: allow, check: check as never, provision: provision as never, notify });
    expect(r).toMatchObject({ ok: true, reason: "ok", method: "http_well_known", token: "ff_tok", tenant: { id: "t1" }, notify: { status: "pending", delivered: true } });
    expect(r.quickstart?.cloudflareEnv.SITE_ANALYTICS_INGEST_TOKEN).toBe("ff_tok");
    expect(provision).toHaveBeenCalledWith({ name: "acme.com", siteLabel: "acme.com" });
    expect(notify).toHaveBeenCalledWith("t1", "qa@thewolfpack.agency");
    expect(s.row).toMatchObject({ status: "approved", tenant_id: "t1", ownership_method: "http_well_known" });
    // A second click: already verified, nothing provisioned again.
    expect((await verifyOwnership(s.key, { q: s.q, limiter: allow, check: check as never, provision: provision as never, notify })).reason).toBe("already_verified");
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("a concurrent click that loses the claim provisions nothing", async () => {
    const s = store();
    const check = jest.fn(async () => ({ ok: true }));
    const provision = jest.fn(async () => ({ tenant, token: "ff_tok" }));
    s.row.status = "pending";
    const originalQ = s.q as unknown as jest.Mock;
    const racing = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("SET status = 'provisioning'")) return []; // another request won
      return originalQ(sql, params);
    });
    const r = await verifyOwnership(s.key, { q: racing as never, limiter: allow, check: check as never, provision: provision as never, notify: jest.fn() });
    expect(r.reason).toBe("already_verified");
    expect(provision).not.toHaveBeenCalled();
  });

  it("provisioning failure releases the claim", async () => {
    const s = store();
    const r = await verifyOwnership(s.key, { q: s.q, limiter: allow, check: (async () => ({ ok: true })) as never, provision: (async () => null) as never, notify: jest.fn() });
    expect(r.reason).toBe("provision_failed");
    expect(s.row.status).toBe("pending");
  });

  it("rate limited per request", async () => {
    const s = store();
    expect((await verifyOwnership(s.key, { q: s.q, limiter: async () => ({ allowed: false }) })).reason).toBe("rate_limited");
  });
});

describe("getOnboardingState + concierge", () => {
  it("verify step carries the instructions; connect step carries tenant, connection and notify", async () => {
    const s = store();
    const v = await getOnboardingState(s.key, { q: s.q });
    expect(v.ok && v.state.step).toBe("verify");
    expect(v.ok && v.state.ownership.instructions[0].value).toBe("ogiam-site-verification=chal");
    expect(v.ok && v.state.noCodeConnect).toEqual(NO_CODE_CONNECT);
    expect(NO_CODE_CONNECT.status).toBe("planned");

    const c = store({ status: "approved", tenant_id: "t1", ownership_verified_at: "x", ownership_method: "dns_txt" });
    const st = await getOnboardingState(c.key, {
      q: c.q,
      connection: async () => ({ connected: true, everConnected: true, lastEventAt: "x" }),
      notifyState: async () => ({ email: "qa@thewolfpack.agency", status: "pending", confirmedAt: null }),
    });
    expect(st.ok && st.state).toMatchObject({ step: "connect", tenant: { id: "t1" }, connection: { connected: true }, notify: { status: "pending" } });
    expect(st.ok && st.state.ownership.instructions).toEqual([]);
    expect((await getOnboardingState("ffs_nope", { q: c.q })).ok).toBe(false);
  });

  it("concierge by key and by tenant", async () => {
    const s = store();
    expect(await requestConcierge({ setupKey: s.key }, "help", s.q)).toEqual({ ok: true, reason: "ok", requestId: "req-1" });
    expect(s.row.concierge_requested_at).toBe("now");
    const q = jest.fn(async () => []);
    expect((await requestConcierge({ tenantId: "t9" }, null, q as never)).reason).toBe("not_found");
    expect((q.mock.calls[0] as unknown[])[0]).toContain("WHERE tenant_id = $1");
  });
});
