/**
 * Forcefield self-serve signup - the GATED intake queue.
 *
 * A public request creates a PENDING row (createSignupRequest); it never mints a
 * token. An operator lists (listSignupRequests) and approves (approveSignupRequest,
 * which provisions a tenant via createForcefieldTenant and returns the token once)
 * or rejects (rejectSignupRequest). The gate is deliberate: open token minting is
 * an abuse surface we will not open until billing + rate/pen-test controls land.
 *
 * Everything here is injectable (query fn) so it is unit-testable without a DB, and
 * nothing throws into the caller - a failure degrades to a typed result.
 */
import { createHash } from "crypto";
import { safeQuery } from "@/lib/db";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { createForcefieldTenant, type ForcefieldTenant } from "@/lib/forcefield-web/tenants";

/** Honeypot field name - a real user never fills it; a bot fills every field. */
export const HONEYPOT_FIELD = "_hp_company";
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX = 5;
const MAX_LEN = 500;
const MAX_NOTE = 2000;

export type SignupQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
const liveQuery: SignupQuery = async (sql, params) => (await safeQuery(sql, params ?? [])).rows as never;

export interface SignupRequest {
  id: string;
  name: string;
  email: string;
  siteUrl: string;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  tenantId: string | null;
  createdAt: string;
}

export type SignupSubmitReason = "ok" | "duplicate" | "invalid" | "honeypot" | "rate_limited" | "error";
export interface SignupSubmitResult {
  ok: boolean;
  reason: SignupSubmitReason;
  requestId?: string;
  retryAfterSec?: number;
}

// --- validation --------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown, max = MAX_LEN): string => String(v ?? "").trim().slice(0, max);

/** Normalize a site into a bare host label (drops scheme, path, www) so the
 *  dedupe key and the later tenant site label are stable. Returns "" if unusable. */
export function normalizeSite(raw: string): string {
  const v = clean(raw).toLowerCase();
  if (!v) return "";
  const host = v
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .trim();
  // A host must have at least one dot and no spaces to be plausible.
  if (!host || host.includes(" ") || !host.includes(".")) return "";
  return host.slice(0, 200);
}

export interface ValidatedSignup {
  name: string;
  email: string;
  siteUrl: string;
  note: string | null;
}
export function validateSignup(input: Record<string, unknown>): ValidatedSignup | null {
  const name = clean(input.name, 200);
  const email = clean(input.email, 200).toLowerCase();
  const siteUrl = normalizeSite(clean(input.siteUrl ?? input.site ?? ""));
  const note = clean(input.note, MAX_NOTE) || null;
  if (name.length < 2) return null;
  if (!EMAIL_RE.test(email)) return null;
  if (!siteUrl) return null;
  return { name, email, siteUrl, note };
}

// --- rate limiting (DURABLE: DB fixed-window, shared across lambdas) ----------

export function hashIp(ip: string | null | undefined): string {
  return createHash("sha256").update(String(ip ?? "unknown")).digest("hex");
}

/** A per-IP limiter decision. Injectable so the intake is unit-testable without a DB. */
export type SignupLimiter = (ipHash: string) => Promise<{ allowed: boolean }>;

/**
 * The real limiter: the shared DB fixed-window counter (checkRateLimit), keyed per
 * IP. Durable across instances and cold starts, fail-closed on a DB error - unlike
 * the in-memory map this replaced, which a serverless fan-out could flood past.
 */
const durableLimiter: SignupLimiter = async (ipHash) => {
  const r = await checkRateLimit(`forcefield:signup:${ipHash}`, {
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  return { allowed: r.ok };
};

// --- intake ------------------------------------------------------------------

export interface CreateSignupInput {
  raw: Record<string, unknown>;
  ipHash?: string;
}

/**
 * Validate + rate-limit + dedupe + insert a PENDING signup request. Never mints a
 * token. A tripped honeypot returns ok:false reason:"honeypot" but the CALLER should
 * still answer the client with a success shape so a bot learns nothing.
 */
export async function createSignupRequest(
  input: CreateSignupInput,
  q: SignupQuery = liveQuery,
  limiter: SignupLimiter = durableLimiter,
): Promise<SignupSubmitResult> {
  // Honeypot: a filled hidden field means a bot.
  if (clean(input.raw[HONEYPOT_FIELD], 50)) return { ok: false, reason: "honeypot" };

  const ipHash = input.ipHash ?? hashIp(null);
  const rl = await limiter(ipHash);
  if (!rl.allowed) return { ok: false, reason: "rate_limited" };

  const valid = validateSignup(input.raw);
  if (!valid) return { ok: false, reason: "invalid" };

  try {
    const [row] = await q<{ id: string }>(
      `INSERT INTO forcefield_signup_requests (name, email, site_url, note, ip_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lower(email), lower(site_url)) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [valid.name, valid.email, valid.siteUrl, valid.note, ipHash],
    );
    if (!row) return { ok: true, reason: "duplicate" }; // already have an open request; treat as success
    return { ok: true, reason: "ok", requestId: row.id };
  } catch {
    return { ok: false, reason: "error" };
  }
}

function rowToRequest(r: {
  id: string; name: string; email: string; site_url: string; note: string | null;
  status: string; tenant_id: string | null; created_at: string;
}): SignupRequest {
  return {
    id: r.id, name: r.name, email: r.email, siteUrl: r.site_url, note: r.note,
    status: (r.status as SignupRequest["status"]) ?? "pending",
    tenantId: r.tenant_id, createdAt: r.created_at,
  };
}

/** List requests, newest first, optionally filtered by status. Never throws. */
export async function listSignupRequests(status?: SignupRequest["status"], q: SignupQuery = liveQuery): Promise<SignupRequest[]> {
  try {
    const rows = status
      ? await q<Parameters<typeof rowToRequest>[0]>(
          `SELECT id, name, email, site_url, note, status, tenant_id, created_at::text AS created_at
           FROM forcefield_signup_requests WHERE status = $1 ORDER BY created_at DESC LIMIT 500`,
          [status],
        )
      : await q<Parameters<typeof rowToRequest>[0]>(
          `SELECT id, name, email, site_url, note, status, tenant_id, created_at::text AS created_at
           FROM forcefield_signup_requests ORDER BY created_at DESC LIMIT 500`,
        );
    return rows.map(rowToRequest);
  } catch {
    return [];
  }
}

export interface ApprovalResult {
  ok: boolean;
  reason: "ok" | "not_found" | "already_reviewed" | "provision_failed" | "error";
  tenant?: ForcefieldTenant;
  token?: string;
}

/**
 * Approve a pending request: provision a tenant (issuing its token) and mark the
 * request approved with the tenant id. Returns the tenant + raw token ONCE. Idempotent
 * against double-approval: a non-pending request returns already_reviewed.
 */
export async function approveSignupRequest(
  id: string,
  reviewedBy: string,
  q: SignupQuery = liveQuery,
  provision = createForcefieldTenant,
): Promise<ApprovalResult> {
  try {
    const [req] = await q<{ name: string; email: string; site_url: string; status: string }>(
      `SELECT name, email, site_url, status FROM forcefield_signup_requests WHERE id = $1`,
      [id],
    );
    if (!req) return { ok: false, reason: "not_found" };
    if (req.status !== "pending") return { ok: false, reason: "already_reviewed" };

    const created = await provision({ name: req.name, siteLabel: req.site_url });
    if (!created) return { ok: false, reason: "provision_failed" };

    await q(
      `UPDATE forcefield_signup_requests
       SET status = 'approved', tenant_id = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, created.tenant.id, reviewedBy],
    );
    return { ok: true, reason: "ok", tenant: created.tenant, token: created.token };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Reject a pending request. Idempotent: a non-pending request returns already_reviewed. */
export async function rejectSignupRequest(id: string, reviewedBy: string, q: SignupQuery = liveQuery): Promise<{ ok: boolean; reason: "ok" | "not_found" | "already_reviewed" | "error" }> {
  try {
    const [req] = await q<{ status: string }>(
      `SELECT status FROM forcefield_signup_requests WHERE id = $1`,
      [id],
    );
    if (!req) return { ok: false, reason: "not_found" };
    if (req.status !== "pending") return { ok: false, reason: "already_reviewed" };
    await q(
      `UPDATE forcefield_signup_requests
       SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, reviewedBy],
    );
    return { ok: true, reason: "ok" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
