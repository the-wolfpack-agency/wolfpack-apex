/**
 * A tenant's Forcefield ALERT ADDRESS and its double opt-in.
 *
 * Lifecycle (columns on forcefield_tenants, migration 298):
 *   set     -> notify_status = 'pending'; a signed confirmation token (JWT via the
 *              crypto registry, purpose ff_notify_confirm, 48h) is emailed. Only
 *              its SHA-256 is stored, and it is single-use.
 *   confirm -> notify_status = 'confirmed'; the stored hash is cleared.
 *   remove  -> the address and its state are cleared.
 *   unsubscribe (one link in every email, signed JWT bound to tenant + address)
 *           -> notify_status = 'unsubscribed'.
 *
 * Only a CONFIRMED address on the recipient allowlist ever receives anything
 * beyond the single confirmation email, and that email itself goes through the
 * guarded sender (tenant-mail.ts). An address that is not on the allowlist is
 * refused at input ("not_allowed") as well, so the build-phase rule holds at
 * both ends.
 *
 * Everything is injectable (query, sender, limiter, clock) and nothing throws
 * into a caller: a failure degrades to a typed reason.
 */
import { randomBytes } from "node:crypto";
import { query } from "@/lib/db";
import { signToken, verifyToken } from "@/lib/crypto/sign";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { instinctPublicBaseUrl } from "@/lib/mail/public-base-url";
import { hashToken, type TenantQuery } from "@/lib/forcefield-web/tenants";
import { isRecipientAllowed } from "@/lib/forcefield-web/recipient-allowlist";
import { sendForcefieldTenantMail, type TenantMail, type TenantMailResult } from "@/lib/forcefield-web/tenant-mail";
import { renderConfirmEmail } from "@/lib/forcefield-web/tenant-email";

export const CONFIRM_TTL_HOURS = 48;
export const UNSUBSCRIBE_TTL_DAYS = 400;
/** Confirmation emails per tenant per hour (set + resend). */
export const CONFIRM_SEND_LIMIT = 5;
export const CONFIRM_SEND_WINDOW_MS = 60 * 60 * 1000;

const PURPOSE_CONFIRM = "ff_notify_confirm";
const PURPOSE_UNSUB = "ff_notify_unsub";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NotifyStatus = "pending" | "confirmed" | "unsubscribed";

export interface NotifyState {
  email: string | null;
  status: NotifyStatus | null;
  confirmedAt: string | null;
  /** True while delivery is restricted to Wolfpack addresses (build phase). */
  restricted?: boolean;
}

export interface NotifyDeps {
  q?: TenantQuery;
  send?: (mail: TenantMail) => Promise<TenantMailResult>;
  limiter?: (key: string) => Promise<{ allowed: boolean }>;
  baseUrl?: string;
  now?: () => Date;
}

const liveQuery: TenantQuery = async (sql, params) => (await query(sql, params ?? [])).rows as never;
const liveLimiter = async (key: string) => ({
  allowed: (await checkRateLimit(`forcefield:notify:${key}`, { limit: CONFIRM_SEND_LIMIT, windowMs: CONFIRM_SEND_WINDOW_MS })).ok,
});

export function normalizeEmail(raw: unknown): string | null {
  const v = String(raw ?? "").trim().toLowerCase().slice(0, 200);
  return EMAIL_RE.test(v) ? v : null;
}

/** "ab***@thewolfpack.agency" for display where the full address is not needed. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export function mintConfirmToken(tenantId: string, email: string): string {
  return signToken({ p: PURPOSE_CONFIRM, t: tenantId, e: email, n: randomBytes(12).toString("base64url") }, { ttlSeconds: CONFIRM_TTL_HOURS * 3600 });
}

export function mintUnsubscribeToken(tenantId: string, email: string): string {
  return signToken({ p: PURPOSE_UNSUB, t: tenantId, e: email }, { ttlSeconds: UNSUBSCRIBE_TTL_DAYS * 86400 });
}

type Claims = { p?: string; t?: string; e?: string };

/** Verify a token's signature, expiry and purpose. */
export function readToken(token: string, purpose: "confirm" | "unsubscribe"): { ok: true; tenantId: string; email: string } | { ok: false; reason: "invalid" | "expired" } {
  const t = String(token ?? "").trim();
  if (!t || t.length > 2048) return { ok: false, reason: "invalid" };
  const v = verifyToken<Claims>(t);
  if (!v.valid) return { ok: false, reason: v.reason === "expired" ? "expired" : "invalid" };
  const want = purpose === "confirm" ? PURPOSE_CONFIRM : PURPOSE_UNSUB;
  if (v.payload.p !== want || typeof v.payload.t !== "string" || typeof v.payload.e !== "string") return { ok: false, reason: "invalid" };
  return { ok: true, tenantId: v.payload.t, email: v.payload.e };
}

interface NotifyRow {
  id: string;
  site_label: string;
  notify_email: string | null;
  notify_status: string | null;
  notify_confirm_token_sha256: string | null;
  notify_confirm_expires_at: string | null;
  notify_confirmed_at: string | null;
}

async function loadRow(tenantId: string, q: TenantQuery): Promise<NotifyRow | null> {
  const [row] = await q<NotifyRow>(
    `SELECT id, site_label, notify_email, notify_status, notify_confirm_token_sha256,
            notify_confirm_expires_at::text AS notify_confirm_expires_at, notify_confirmed_at::text AS notify_confirmed_at
       FROM forcefield_tenants WHERE id = $1 AND status = 'active'`,
    [tenantId],
  );
  return row ?? null;
}

const asStatus = (s: string | null): NotifyStatus | null => (s === "pending" || s === "confirmed" || s === "unsubscribed" ? s : null);

export async function getNotifyState(tenantId: string, deps: NotifyDeps = {}): Promise<NotifyState | null> {
  try {
    const row = await loadRow(tenantId, deps.q ?? liveQuery);
    if (!row) return null;
    return { email: row.notify_email, status: asStatus(row.notify_status), confirmedAt: row.notify_confirmed_at };
  } catch {
    return null;
  }
}

export type SetNotifyReason = "ok" | "invalid" | "not_allowed" | "rate_limited" | "not_found" | "error";
export interface SetNotifyResult {
  ok: boolean;
  reason: SetNotifyReason;
  /** Whether the confirmation email was handed to the mail provider and accepted. */
  delivered?: boolean;
  deliveryReason?: string;
}

/**
 * Set (or re-send for) a tenant's alert address: stores it as pending, mints a
 * fresh single-use confirmation token (storing only its hash) and emails the
 * confirmation link through the guarded sender. Re-setting the same address is a
 * "resend". A previously confirmed address that is replaced goes back to pending.
 */
export async function setNotifyEmail(tenantId: string, rawEmail: unknown, deps: NotifyDeps = {}): Promise<SetNotifyResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid" };
  if (!isRecipientAllowed(email)) return { ok: false, reason: "not_allowed" };
  const q = deps.q ?? liveQuery;
  try {
    const rl = await (deps.limiter ?? liveLimiter)(tenantId);
    if (!rl.allowed) return { ok: false, reason: "rate_limited" };
    const token = mintConfirmToken(tenantId, email);
    const expires = new Date((deps.now?.() ?? new Date()).getTime() + CONFIRM_TTL_HOURS * 3600_000).toISOString();
    const rows = await q<{ site_label: string }>(
      `UPDATE forcefield_tenants
          SET notify_email = $2, notify_status = 'pending', notify_confirm_token_sha256 = $3,
              notify_confirm_expires_at = $4, notify_confirmed_at = NULL, notify_unsubscribed_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING site_label`,
      [tenantId, email, hashToken(token), expires],
    );
    if (rows.length === 0) return { ok: false, reason: "not_found" };
    const site = rows[0].site_label;
    const mail = renderConfirmEmail({ site, to: email, baseUrl: deps.baseUrl ?? instinctPublicBaseUrl(), confirmToken: token, expiresHours: CONFIRM_TTL_HOURS });
    const sent = await (deps.send ?? sendForcefieldTenantMail)({ to: email, subject: mail.subject, text: mail.text, html: mail.html, purpose: "confirm", tenantId });
    return { ok: true, reason: "ok", delivered: sent.delivered, deliveryReason: sent.reason };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type ConfirmReason = "ok" | "invalid" | "expired" | "already_confirmed" | "not_found" | "error";
export interface ConfirmResult { ok: boolean; reason: ConfirmReason; tenantId?: string; site?: string }

/** Confirm an alert address from the emailed link. Single use. */
export async function confirmNotifyEmail(token: string, deps: NotifyDeps = {}): Promise<ConfirmResult> {
  const claims = readToken(token, "confirm");
  if (!claims.ok) return { ok: false, reason: claims.reason };
  const q = deps.q ?? liveQuery;
  try {
    const row = await loadRow(claims.tenantId, q);
    if (!row || row.notify_email !== claims.email) return { ok: false, reason: "not_found" };
    if (row.notify_status === "confirmed") return { ok: false, reason: "already_confirmed", tenantId: row.id, site: row.site_label };
    if (row.notify_status !== "pending" || !row.notify_confirm_token_sha256) return { ok: false, reason: "not_found" };
    // Only the most recently issued token works (resending replaces the hash).
    if (!timingSafeEqualStr(row.notify_confirm_token_sha256, hashToken(String(token).trim()))) return { ok: false, reason: "invalid" };
    const now = deps.now?.() ?? new Date();
    if (row.notify_confirm_expires_at && Date.parse(row.notify_confirm_expires_at) <= now.getTime()) return { ok: false, reason: "expired" };
    const updated = await q<{ id: string }>(
      `UPDATE forcefield_tenants
          SET notify_status = 'confirmed', notify_confirmed_at = now(), notify_confirm_token_sha256 = NULL,
              notify_confirm_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND notify_status = 'pending' AND notify_confirm_token_sha256 = $2
        RETURNING id`,
      [row.id, row.notify_confirm_token_sha256],
    );
    if (updated.length === 0) return { ok: false, reason: "already_confirmed", tenantId: row.id, site: row.site_label };
    return { ok: true, reason: "ok", tenantId: row.id, site: row.site_label };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Remove the tenant's alert address entirely. Idempotent. */
export async function removeNotifyEmail(tenantId: string, deps: NotifyDeps = {}): Promise<{ ok: boolean; reason: "ok" | "not_found" | "error" }> {
  try {
    const rows = await (deps.q ?? liveQuery)<{ id: string }>(
      `UPDATE forcefield_tenants
          SET notify_email = NULL, notify_status = NULL, notify_confirm_token_sha256 = NULL,
              notify_confirm_expires_at = NULL, notify_confirmed_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING id`,
      [tenantId],
    );
    return rows.length ? { ok: true, reason: "ok" } : { ok: false, reason: "not_found" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type UnsubscribeReason = "ok" | "invalid" | "expired" | "not_found" | "error";

/** One-link unsubscribe. Bound to tenant + address, so a link from an old
 *  address cannot touch a newer one. Idempotent for the same address. */
export async function unsubscribeNotify(token: string, deps: NotifyDeps = {}): Promise<{ ok: boolean; reason: UnsubscribeReason; tenantId?: string; site?: string }> {
  const claims = readToken(token, "unsubscribe");
  if (!claims.ok) return { ok: false, reason: claims.reason };
  try {
    const rows = await (deps.q ?? liveQuery)<{ id: string; site_label: string }>(
      `UPDATE forcefield_tenants
          SET notify_status = 'unsubscribed', notify_unsubscribed_at = COALESCE(notify_unsubscribed_at, now()),
              notify_confirm_token_sha256 = NULL, notify_confirm_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND notify_email = $2
        RETURNING id, site_label`,
      [claims.tenantId, claims.email],
    );
    return rows.length ? { ok: true, reason: "ok", tenantId: rows[0].id, site: rows[0].site_label } : { ok: false, reason: "not_found" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
