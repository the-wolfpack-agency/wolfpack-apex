/**
 * Unit tests for the Forcefield signup intake lib - the gated self-serve queue.
 * Proves validation, the honeypot, per-IP rate limiting, dedupe, and that approval
 * provisions a tenant + returns the token once while rejection closes the request.
 * No database: the query fn and the provisioner are injected.
 */
import {
  validateSignup, normalizeSite, createSignupRequest, approveSignupRequest, rejectSignupRequest,
  listSignupRequests, HONEYPOT_FIELD, type SignupLimiter,
} from "../signup";

// Injected limiters so the intake is tested without the DB-backed checkRateLimit.
const allow: SignupLimiter = async () => ({ allowed: true });
const block: SignupLimiter = async () => ({ allowed: false });

describe("normalizeSite", () => {
  it("strips scheme/www/path and keeps the bare host", () => {
    expect(normalizeSite("https://www.Example.com/pricing?x=1")).toBe("example.com");
    expect(normalizeSite("beforeutrade.com")).toBe("beforeutrade.com");
  });
  it("rejects a non-host string", () => {
    expect(normalizeSite("not a url")).toBe("");
    expect(normalizeSite("localhost")).toBe("");
    expect(normalizeSite("")).toBe("");
  });
});

describe("validateSignup", () => {
  it("accepts a well-formed request and normalizes the site", () => {
    const v = validateSignup({ name: "Dana", email: "DANA@Acme.com", siteUrl: "https://acme.com/" });
    expect(v).toEqual({ name: "Dana", email: "dana@acme.com", siteUrl: "acme.com", note: null });
  });
  it("rejects a bad email, short name, or missing site", () => {
    expect(validateSignup({ name: "D", email: "dana@acme.com", siteUrl: "acme.com" })).toBeNull();
    expect(validateSignup({ name: "Dana", email: "not-an-email", siteUrl: "acme.com" })).toBeNull();
    expect(validateSignup({ name: "Dana", email: "dana@acme.com", siteUrl: "nope" })).toBeNull();
  });
});

describe("createSignupRequest", () => {
  const good = { name: "Dana", email: "dana@acme.com", siteUrl: "acme.com" };

  it("inserts a pending row and returns its id", async () => {
    const q = jest.fn().mockResolvedValueOnce([{ id: "req-1" }]);
    const res = await createSignupRequest({ raw: good, ipHash: "h" }, q, allow);
    expect(res).toEqual({ ok: true, reason: "ok", requestId: "req-1" });
    // never mints a token - the only write is the pending insert
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][0]).toMatch(/INSERT INTO forcefield_signup_requests/);
  });

  it("treats a tripped honeypot as a silent non-insert (before the limiter)", async () => {
    const q = jest.fn();
    const limiter = jest.fn(allow);
    const res = await createSignupRequest({ raw: { ...good, [HONEYPOT_FIELD]: "bot" }, ipHash: "h" }, q, limiter);
    expect(res.reason).toBe("honeypot");
    expect(q).not.toHaveBeenCalled();
    expect(limiter).not.toHaveBeenCalled();
  });

  it("returns invalid (no write) on a bad payload", async () => {
    const q = jest.fn();
    const res = await createSignupRequest({ raw: { name: "x", email: "bad", siteUrl: "" }, ipHash: "h" }, q, allow);
    expect(res.reason).toBe("invalid");
    expect(q).not.toHaveBeenCalled();
  });

  it("maps an ON CONFLICT no-row (duplicate open request) to a success", async () => {
    const q = jest.fn().mockResolvedValueOnce([]); // DO NOTHING -> no RETURNING row
    const res = await createSignupRequest({ raw: good, ipHash: "h" }, q, allow);
    expect(res).toEqual({ ok: true, reason: "duplicate" });
  });

  it("rate-limits via the durable limiter (no insert when blocked)", async () => {
    const q = jest.fn();
    const res = await createSignupRequest({ raw: good, ipHash: "same" }, q, block);
    expect(res.reason).toBe("rate_limited");
    expect(q).not.toHaveBeenCalled(); // blocked before any write
  });

  it("keys the limiter by the submitter ip", async () => {
    const q = jest.fn().mockResolvedValueOnce([{ id: "r" }]);
    const limiter = jest.fn(allow);
    await createSignupRequest({ raw: good, ipHash: "ip-xyz" }, q, limiter);
    expect(limiter).toHaveBeenCalledWith("ip-xyz");
  });

  it("never throws - a DB error degrades to reason:error", async () => {
    const q = jest.fn().mockRejectedValueOnce(new Error("db down"));
    const res = await createSignupRequest({ raw: good, ipHash: "h" }, q, allow);
    expect(res).toEqual({ ok: false, reason: "error" });
  });
});

describe("approveSignupRequest", () => {
  it("provisions a tenant, marks approved, and returns the token once", async () => {
    const q = jest.fn()
      .mockResolvedValueOnce([{ name: "Acme", email: "dana@acme.com", site_url: "acme.com", status: "pending" }]) // SELECT
      .mockResolvedValueOnce([]); // UPDATE
    const provision = jest.fn().mockResolvedValue({
      tenant: { id: "t-9", name: "Acme", siteLabel: "acme.com", status: "active", createdAt: "2026-10-06T00:00:00Z" },
      token: "ff_minted",
    });
    const res = await approveSignupRequest("req-1", "op-1", q, provision);
    expect(res.ok).toBe(true);
    expect(res.token).toBe("ff_minted");
    expect(res.tenant?.id).toBe("t-9");
    expect(provision).toHaveBeenCalledWith({ name: "Acme", siteLabel: "acme.com" });
    // the UPDATE links the request to the new tenant
    expect(q.mock.calls[1][0]).toMatch(/UPDATE forcefield_signup_requests/);
    expect(q.mock.calls[1][1]).toEqual(["req-1", "t-9", "op-1"]);
  });

  it("is idempotent against double-approval", async () => {
    const q = jest.fn().mockResolvedValueOnce([{ name: "Acme", email: "x", site_url: "acme.com", status: "approved" }]);
    const provision = jest.fn();
    const res = await approveSignupRequest("req-1", "op-1", q, provision);
    expect(res).toEqual({ ok: false, reason: "already_reviewed" });
    expect(provision).not.toHaveBeenCalled();
  });

  it("returns not_found for an unknown id", async () => {
    const q = jest.fn().mockResolvedValueOnce([]);
    const res = await approveSignupRequest("nope", "op-1", q, jest.fn());
    expect(res.reason).toBe("not_found");
  });

  it("surfaces provision_failed without marking the request approved", async () => {
    const q = jest.fn().mockResolvedValueOnce([{ name: "Acme", email: "x", site_url: "acme.com", status: "pending" }]);
    const provision = jest.fn().mockResolvedValue(null);
    const res = await approveSignupRequest("req-1", "op-1", q, provision);
    expect(res.reason).toBe("provision_failed");
    expect(q).toHaveBeenCalledTimes(1); // SELECT only, no UPDATE
  });
});

describe("rejectSignupRequest", () => {
  it("closes a pending request", async () => {
    const q = jest.fn()
      .mockResolvedValueOnce([{ status: "pending" }])
      .mockResolvedValueOnce([]);
    const res = await rejectSignupRequest("req-1", "op-1", q);
    expect(res).toEqual({ ok: true, reason: "ok" });
    expect(q.mock.calls[1][0]).toMatch(/SET status = 'rejected'/);
  });
  it("is idempotent for an already-reviewed request", async () => {
    const q = jest.fn().mockResolvedValueOnce([{ status: "rejected" }]);
    const res = await rejectSignupRequest("req-1", "op-1", q);
    expect(res.reason).toBe("already_reviewed");
  });
});

describe("listSignupRequests", () => {
  it("maps rows and never throws on error", async () => {
    const q = jest.fn().mockResolvedValueOnce([
      { id: "r1", name: "A", email: "a@x.com", site_url: "x.com", note: null, status: "pending", tenant_id: null, created_at: "2026-10-06T00:00:00Z" },
    ]);
    const rows = await listSignupRequests("pending", q);
    expect(rows[0]).toMatchObject({ id: "r1", siteUrl: "x.com", status: "pending" });
    const bad = jest.fn().mockRejectedValueOnce(new Error("x"));
    expect(await listSignupRequests("pending", bad)).toEqual([]);
  });
});
