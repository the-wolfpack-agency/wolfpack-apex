/** @jest-environment node */
/**
 * Alert-address double opt-in: signed, expiring, single-use confirmation token
 * (only its hash stored), purpose separation between confirm and unsubscribe,
 * allowlist refusal at input, rate limit, and every confirm failure mode.
 */
process.env.INSTINCT_JWT_SECRET = "test-secret-for-tenant-notify-0123456789abcdef";
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({ checkRateLimit: jest.fn(async () => ({ ok: true, remaining: 1 })) }));

import { hashToken } from "@/lib/forcefield-web/tenants";
import {
  setNotifyEmail, confirmNotifyEmail, unsubscribeNotify, removeNotifyEmail, getNotifyState,
  mintConfirmToken, mintUnsubscribeToken, readToken, maskEmail, normalizeEmail,
} from "@/lib/forcefield-web/tenant-notify";
import { signToken } from "@/lib/crypto/sign";

type Row = {
  id: string; site_label: string; notify_email: string | null; notify_status: string | null;
  notify_confirm_token_sha256: string | null; notify_confirm_expires_at: string | null; notify_confirmed_at: string | null;
};

/** A tiny in-memory forcefield_tenants for the lib's statements. */
function fakeDb(initial: Partial<Row> = {}) {
  const row: Row = { id: "t1", site_label: "acme.com", notify_email: null, notify_status: null, notify_confirm_token_sha256: null, notify_confirm_expires_at: null, notify_confirmed_at: null, ...initial };
  const calls: string[] = [];
  const q = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (sql.startsWith("SELECT")) return params[0] === row.id ? [{ ...row }] : [];
    if (sql.includes("SET notify_email = $2, notify_status = 'pending'")) {
      if (params[0] !== row.id) return [];
      Object.assign(row, { notify_email: params[1], notify_status: "pending", notify_confirm_token_sha256: params[2], notify_confirm_expires_at: params[3], notify_confirmed_at: null });
      return [{ site_label: row.site_label }];
    }
    if (sql.includes("SET notify_status = 'confirmed'")) {
      if (params[0] !== row.id || row.notify_status !== "pending" || row.notify_confirm_token_sha256 !== params[1]) return [];
      Object.assign(row, { notify_status: "confirmed", notify_confirmed_at: "now", notify_confirm_token_sha256: null, notify_confirm_expires_at: null });
      return [{ id: row.id }];
    }
    if (sql.includes("SET notify_status = 'unsubscribed'")) {
      if (params[0] !== row.id || row.notify_email !== params[1]) return [];
      row.notify_status = "unsubscribed";
      return [{ id: row.id, site_label: row.site_label }];
    }
    if (sql.includes("SET notify_email = NULL")) {
      if (params[0] !== row.id) return [];
      Object.assign(row, { notify_email: null, notify_status: null, notify_confirmed_at: null });
      return [{ id: row.id }];
    }
    return [];
  });
  return { row, q: q as never, calls };
}

const sent: { to: string; text: string }[] = [];
const send = jest.fn(async (m: { to: string; text: string }) => { sent.push(m); return { delivered: true, reason: "ok" }; });
const allow = async () => ({ allowed: true });
beforeEach(() => { sent.length = 0; send.mockClear(); });

function tokenFromEmail(text: string): string {
  const m = /confirm\?token=([^\s]+)/.exec(text);
  return decodeURIComponent(m![1]);
}

describe("setNotifyEmail", () => {
  it("stores pending + only the token hash, and emails the confirm link to that address", async () => {
    const db = fakeDb();
    const r = await setNotifyEmail("t1", " QA@thewolfpack.agency ", { q: db.q, send, limiter: allow, baseUrl: "https://i.example" });
    expect(r).toMatchObject({ ok: true, reason: "ok", delivered: true });
    expect(db.row.notify_email).toBe("qa@thewolfpack.agency");
    expect(db.row.notify_status).toBe("pending");
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0].to).toBe("qa@thewolfpack.agency");
    const token = tokenFromEmail(sent[0].text);
    expect(db.row.notify_confirm_token_sha256).toBe(hashToken(token));
    expect(db.row.notify_confirm_token_sha256).not.toBe(token);
    expect(sent[0].text).toContain("https://i.example/forcefield/confirm?token=");
    expect(sent[0].text).not.toContain("/admin");
  });

  it("refuses invalid and non-allowlisted addresses before touching the DB or the mailer", async () => {
    const db = fakeDb();
    expect((await setNotifyEmail("t1", "nope", { q: db.q, send, limiter: allow })).reason).toBe("invalid");
    expect((await setNotifyEmail("t1", "owner@client.example", { q: db.q, send, limiter: allow })).reason).toBe("not_allowed");
    expect(db.calls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("rate limited and unknown tenant", async () => {
    const db = fakeDb();
    expect((await setNotifyEmail("t1", "qa@thewolfpack.agency", { q: db.q, send, limiter: async () => ({ allowed: false }) })).reason).toBe("rate_limited");
    expect((await setNotifyEmail("other", "qa@thewolfpack.agency", { q: db.q, send, limiter: allow })).reason).toBe("not_found");
    expect(send).not.toHaveBeenCalled();
  });

  it("a DB error degrades to 'error', never throws", async () => {
    const q = jest.fn(async () => { throw new Error("down"); });
    expect((await setNotifyEmail("t1", "qa@thewolfpack.agency", { q: q as never, send, limiter: allow })).reason).toBe("error");
  });
});

describe("confirmNotifyEmail", () => {
  async function pending() {
    const db = fakeDb();
    await setNotifyEmail("t1", "qa@thewolfpack.agency", { q: db.q, send, limiter: allow });
    return { db, token: tokenFromEmail(sent[sent.length - 1].text) };
  }

  it("confirms once; a second use is already_confirmed", async () => {
    const { db, token } = await pending();
    expect(await confirmNotifyEmail(token, { q: db.q })).toEqual({ ok: true, reason: "ok", tenantId: "t1", site: "acme.com" });
    expect(db.row.notify_status).toBe("confirmed");
    expect(db.row.notify_confirm_token_sha256).toBeNull();
    expect((await confirmNotifyEmail(token, { q: db.q })).reason).toBe("already_confirmed");
  });

  it("only the newest token works after a resend", async () => {
    const { db, token: first } = await pending();
    await setNotifyEmail("t1", "qa@thewolfpack.agency", { q: db.q, send, limiter: allow });
    const second = tokenFromEmail(sent[sent.length - 1].text);
    expect((await confirmNotifyEmail(first, { q: db.q })).reason).toBe("invalid");
    expect((await confirmNotifyEmail(second, { q: db.q })).ok).toBe(true);
  });

  it("expired by the stored expiry", async () => {
    const { db, token } = await pending();
    const later = new Date(Date.now() + 49 * 3600_000);
    expect((await confirmNotifyEmail(token, { q: db.q, now: () => later })).reason).toBe("expired");
  });

  it("expired by the signed exp claim", async () => {
    const db = fakeDb();
    const t = signToken({ p: "ff_notify_confirm", t: "t1", e: "qa@thewolfpack.agency" }, { ttlSeconds: -10 });
    expect((await confirmNotifyEmail(t, { q: db.q })).reason).toBe("expired");
  });

  it("a forged, wrong-purpose or address-changed token is refused", async () => {
    const { db, token } = await pending();
    expect((await confirmNotifyEmail(token + "x", { q: db.q })).reason).toBe("invalid");
    expect((await confirmNotifyEmail(mintUnsubscribeToken("t1", "qa@thewolfpack.agency"), { q: db.q })).reason).toBe("invalid");
    db.row.notify_email = "other@thewolfpack.agency";
    expect((await confirmNotifyEmail(token, { q: db.q })).reason).toBe("not_found");
    expect((await confirmNotifyEmail("", { q: db.q })).reason).toBe("invalid");
  });
});

describe("unsubscribe, remove, state", () => {
  it("unsubscribe is bound to the address it was sent to", async () => {
    const db = fakeDb({ notify_email: "qa@thewolfpack.agency", notify_status: "confirmed" });
    expect((await unsubscribeNotify(mintUnsubscribeToken("t1", "old@thewolfpack.agency"), { q: db.q })).reason).toBe("not_found");
    expect(db.row.notify_status).toBe("confirmed");
    expect(await unsubscribeNotify(mintUnsubscribeToken("t1", "qa@thewolfpack.agency"), { q: db.q })).toEqual({ ok: true, reason: "ok", tenantId: "t1", site: "acme.com" });
    expect(db.row.notify_status).toBe("unsubscribed");
    expect((await unsubscribeNotify(mintConfirmToken("t1", "qa@thewolfpack.agency"), { q: db.q })).reason).toBe("invalid");
  });

  it("remove clears the address; state reflects it", async () => {
    const db = fakeDb({ notify_email: "qa@thewolfpack.agency", notify_status: "confirmed", notify_confirmed_at: "x" });
    expect(await getNotifyState("t1", { q: db.q })).toEqual({ email: "qa@thewolfpack.agency", status: "confirmed", confirmedAt: "x" });
    expect((await removeNotifyEmail("t1", { q: db.q })).ok).toBe(true);
    expect(await getNotifyState("t1", { q: db.q })).toEqual({ email: null, status: null, confirmedAt: null });
    expect((await removeNotifyEmail("nope", { q: db.q })).reason).toBe("not_found");
    expect(await getNotifyState("nope", { q: db.q })).toBeNull();
  });

  it("helpers", () => {
    expect(maskEmail("qa@thewolfpack.agency")).toBe("qa***@thewolfpack.agency");
    expect(normalizeEmail(" A@B.CO ")).toBe("a@b.co");
    expect(normalizeEmail("x")).toBeNull();
    const t = mintConfirmToken("t1", "a@b.co");
    expect(readToken(t, "confirm")).toEqual({ ok: true, tenantId: "t1", email: "a@b.co" });
    expect(readToken(t, "unsubscribe")).toEqual({ ok: false, reason: "invalid" });
  });
});
