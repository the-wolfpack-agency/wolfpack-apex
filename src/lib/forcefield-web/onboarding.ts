/**
 * Forcefield SELF-SERVE ONBOARDING: add a site, name an alert address, prove
 * ownership, connect, confirm the address, see evidence.
 *
 *   1. startForcefieldOnboarding    a person enters their site + alert email. The intake row
 *                         lands in forcefield_signup_requests (kind 'self_serve')
 *                         and the browser gets a one-time SETUP KEY (stored only as
 *                         a SHA-256) that authorizes the next steps. An ownership
 *                         challenge is issued through the platform-scan
 *                         verification (issueVerificationToken).
 *   2. verifyOwnership    one click: the platform-scan check (checkVerification)
 *                         tries the well-known file, then the DNS TXT record.
 *                         Proven ownership is the gate that replaces the operator
 *                         review for this path: it provisions the tenant
 *                         (createForcefieldTenant), returns the ingest token ONCE,
 *                         and sends the double opt-in email (tenant-notify.ts).
 *   3. connect            the existing quick-start (buildTenantQuickstart) plus a
 *                         "we'll do it for you" request (requestConcierge).
 *   4. confirm            tenant-notify.ts (signed, expiring, single-use token).
 *   5. first evidence     tenant-alerts.ts (cron).
 *
 * BUILD PHASE: only an address on the recipient allowlist starts the self-serve
 * flow. Any other address is filed in the existing operator-reviewed request
 * queue (createSignupRequest) and is sent nothing, so nobody outside Wolfpack is
 * messaged and nobody outside Wolfpack is provisioned without review.
 *
 * Deterministic (no model client). Injectable deps; never throws into a route.
 */
import { randomBytes } from "node:crypto";
import { query } from "@/lib/db";
import { runWithRequestWorkspace } from "@/lib/db/request-workspace";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import {
  issueVerificationToken,
  checkVerification,
  WELL_KNOWN_PATH,
  DNS_TXT_PREFIX,
  type VerificationMethod,
} from "@/lib/platform-scan/authorization";
import { createForcefieldTenant, hashToken, type ForcefieldTenant, type TenantQuery } from "@/lib/forcefield-web/tenants";
import { buildTenantQuickstart, type TenantQuickstart } from "@/lib/forcefield-web/tenant-quickstart";
import { getTenantConnection, type TenantConnection } from "@/lib/forcefield-web/public-stats";
import { createSignupRequest, normalizeSite, HONEYPOT_FIELD } from "@/lib/forcefield-web/signup";
import { isRecipientAllowed } from "@/lib/forcefield-web/recipient-allowlist";
import { detectSitePlatform, connectorForPlatform, isDetectedPlatform, type DetectedPlatform, type PlatformDetection } from "@/lib/forcefield-web/platform-detect";
import { getNotifyState, normalizeEmail, setNotifyEmail, type NotifyState, type SetNotifyResult } from "@/lib/forcefield-web/tenant-notify";

/** The verification rows for self-serve sites live in their own workspace, so
 *  they never mix with platform-scan targets. */
export const ONBOARDING_WORKSPACE = "forcefield-self-serve";
export const START_LIMIT = 5;
export const START_WINDOW_MS = 15 * 60 * 1000;
export const VERIFY_LIMIT = 20;
export const VERIFY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Where the no-code connect plugs in. Today the lightest options are the
 * existing per-stack snippet/env (buildTenantQuickstart) and the concierge
 * request. The planned no-code path is Cloudflare for SaaS custom hostnames:
 * the customer adds ONE DNS record (a CNAME to our edge) and a Worker running
 * the Forcefield engine (adapters/cloudflare-worker.ts) proxies their traffic.
 * That needs infrastructure approval first; until then this stays "planned" and
 * the UI shows it as coming soon. When it ships, return its instructions here
 * and the setup page renders them as the first option.
 */
export const NO_CODE_CONNECT = { status: "planned" as const, method: "dns_proxy" as const, provider: "cloudflare_for_saas" as const };

export const verificationPlatform = (requestId: string) => `ff-signup:${requestId}`;

export function generateSetupKey(): string {
  return `ffs_${randomBytes(24).toString("base64url")}`;
}

export interface OwnershipInstructions {
  method: VerificationMethod;
  summary: string;
  location: string;
  value: string;
}

/** The two proof options for a site, from the platform-scan constants. */
export function ownershipInstructions(site: string, token: string): OwnershipInstructions[] {
  return [
    { method: "dns_txt", summary: `Add a DNS TXT record on ${site} with this value.`, location: site, value: `${DNS_TXT_PREFIX}${token}` },
    { method: "http_well_known", summary: `Or serve this text file on your site.`, location: `https://${site}${WELL_KNOWN_PATH}`, value: token },
  ];
}

const liveQuery: TenantQuery = async (sql, params) => (await query(sql, params ?? [])).rows as never;

export type Limiter = (key: string) => Promise<{ allowed: boolean }>;
export const limiterFor = (prefix: string, limit: number, windowMs: number): Limiter => async (key) => ({
  allowed: (await checkRateLimit(`${prefix}:${key}`, { limit, windowMs })).ok,
});

export interface OnboardingDeps {
  q?: TenantQuery;
  limiter?: Limiter;
  issue?: (workspaceId: string, platform: string) => Promise<{ token: string }>;
  check?: typeof checkVerification;
  provision?: typeof createForcefieldTenant;
  notify?: (tenantId: string, email: string) => Promise<SetNotifyResult>;
  fallbackRequest?: typeof createSignupRequest;
  connection?: (tenantId: string) => Promise<TenantConnection>;
  notifyState?: (tenantId: string) => Promise<NotifyState | null>;
  /** The read-only home-page platform check (platform-detect.ts). */
  detect?: (site: string) => Promise<PlatformDetection>;
}

const issueLive = (ws: string, platform: string) => runWithRequestWorkspace(ws, () => issueVerificationToken(ws, platform));

/* --------------------------------- step 1 --------------------------------- */

export type StartReason = "ok" | "request" | "honeypot" | "invalid" | "rate_limited" | "error";
export interface StartResult {
  ok: boolean;
  reason: StartReason;
  requestId?: string;
  setupKey?: string;
  site?: string;
  email?: string;
  ownership?: OwnershipInstructions[];
  /** Which install option fits the site (wordpress | vercel | other). */
  platform?: PlatformDetection;
}

export function validateOnboarding(raw: Record<string, unknown>): { site: string; email: string; name: string } | null {
  const site = normalizeSite(String(raw.siteUrl ?? raw.site ?? ""));
  const email = normalizeEmail(raw.email);
  if (!site || !email) return null;
  const nameRaw = String(raw.name ?? "").trim().slice(0, 200);
  return { site, email, name: nameRaw.length >= 2 ? nameRaw : site };
}

export async function startForcefieldOnboarding(input: { raw: Record<string, unknown>; ipHash: string }, deps: OnboardingDeps = {}): Promise<StartResult> {
  if (String(input.raw[HONEYPOT_FIELD] ?? "").trim()) return { ok: false, reason: "honeypot" };
  // Validate first (no IO), so a malformed probe never spends a limiter write.
  const v = validateOnboarding(input.raw);
  if (!v) return { ok: false, reason: "invalid" };
  try {
    const rl = await (deps.limiter ?? limiterFor("forcefield:onboard", START_LIMIT, START_WINDOW_MS))(input.ipHash);
    if (!rl.allowed) return { ok: false, reason: "rate_limited" };
  } catch {
    return { ok: false, reason: "rate_limited" };
  }

  // Build phase: a non-allowlisted address is filed for operator review and
  // sent nothing. Already rate-limited above, so the queue's own limiter is
  // not charged a second time.
  if (!isRecipientAllowed(v.email)) {
    const r = await (deps.fallbackRequest ?? createSignupRequest)(
      { raw: { name: v.name, email: v.email, siteUrl: v.site, note: input.raw.note }, ipHash: input.ipHash },
      undefined,
      async () => ({ allowed: true }),
    );
    if (r.reason === "invalid") return { ok: false, reason: "invalid" };
    if (r.reason === "error") return { ok: false, reason: "error" };
    return { ok: true, reason: "request", requestId: r.requestId };
  }

  const q = deps.q ?? liveQuery;
  const setupKey = generateSetupKey();
  // Never blocks signup: any failure is "other" (the concierge + DIY options).
  const platform = await (deps.detect ?? detectSitePlatform)(v.site).catch((): PlatformDetection => ({ platform: "other", evidence: [], checked: false, reason: "detect_error" }));
  try {
    // A second start for the same open site + email (another browser, a lost
    // key) rotates the setup key; ownership is still required to go further.
    const [row] = await q<{ id: string }>(
      `INSERT INTO forcefield_signup_requests (name, email, site_url, note, ip_hash, kind, setup_key_sha256, detected_platform)
       VALUES ($1, $2, $3, $4, $5, 'self_serve', $6, $7)
       ON CONFLICT (lower(email), lower(site_url)) WHERE status = 'pending'
       DO UPDATE SET setup_key_sha256 = EXCLUDED.setup_key_sha256, kind = 'self_serve',
                     detected_platform = EXCLUDED.detected_platform, updated_at = now()
       RETURNING id`,
      [v.name, v.email, v.site, String(input.raw.note ?? "").trim().slice(0, 2000) || null, input.ipHash, hashToken(setupKey), platform.platform],
    );
    if (!row) return { ok: false, reason: "error" };
    const issued = await (deps.issue ?? issueLive)(ONBOARDING_WORKSPACE, verificationPlatform(row.id));
    return { ok: true, reason: "ok", requestId: row.id, setupKey, site: v.site, email: v.email, ownership: ownershipInstructions(v.site, issued.token), platform };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/* ------------------------------ state lookup ------------------------------ */

interface OnboardingRow {
  id: string;
  email: string;
  site_url: string;
  status: string;
  tenant_id: string | null;
  ownership_method: string | null;
  ownership_verified_at: string | null;
  concierge_requested_at: string | null;
  name: string;
  detected_platform?: string | null;
}

export async function findOnboarding(setupKey: string, q: TenantQuery = liveQuery): Promise<OnboardingRow | null> {
  const key = String(setupKey ?? "").trim();
  if (!key.startsWith("ffs_") || key.length > 200) return null;
  const [row] = await q<OnboardingRow>(
    `SELECT id, name, email, site_url, status, tenant_id, ownership_method,
            ownership_verified_at::text AS ownership_verified_at, concierge_requested_at::text AS concierge_requested_at,
            detected_platform
       FROM forcefield_signup_requests
      WHERE setup_key_sha256 = $1 AND kind = 'self_serve'
      LIMIT 1`,
    [hashToken(key)],
  );
  return row ?? null;
}

export interface OnboardingState {
  requestId: string;
  site: string;
  email: string;
  step: "verify" | "connect";
  ownership: { verified: boolean; method: string | null; verifiedAt: string | null; instructions: OwnershipInstructions[] };
  tenant: { id: string; siteLabel: string } | null;
  connection: TenantConnection | null;
  notify: NotifyState | null;
  conciergeRequested: boolean;
  noCodeConnect: typeof NO_CODE_CONNECT;
  /** The platform found on signup, or null when it was not checked. */
  platform: DetectedPlatform | null;
}

export async function loadChallenge(requestId: string, q: TenantQuery): Promise<string | null> {
  const [row] = await q<{ verification_token: string }>(
    `SELECT verification_token FROM instinct_target_verifications WHERE workspace_id = $1 AND platform = $2 LIMIT 1`,
    [ONBOARDING_WORKSPACE, verificationPlatform(requestId)],
  );
  return row?.verification_token ?? null;
}

export async function getOnboardingState(setupKey: string, deps: OnboardingDeps = {}): Promise<{ ok: true; state: OnboardingState } | { ok: false; reason: "unauthorized" | "error" }> {
  const q = deps.q ?? liveQuery;
  try {
    const row = await findOnboarding(setupKey, q);
    if (!row) return { ok: false, reason: "unauthorized" };
    const verified = !!row.ownership_verified_at && !!row.tenant_id;
    const challenge = verified ? null : await runWithRequestWorkspace(ONBOARDING_WORKSPACE, () => loadChallenge(row.id, q));
    const tenantId = verified ? row.tenant_id : null;
    return {
      ok: true,
      state: {
        requestId: row.id,
        site: row.site_url,
        email: row.email,
        step: verified ? "connect" : "verify",
        ownership: {
          verified,
          method: row.ownership_method,
          verifiedAt: row.ownership_verified_at,
          instructions: challenge ? ownershipInstructions(row.site_url, challenge) : [],
        },
        tenant: tenantId ? { id: tenantId, siteLabel: row.site_url } : null,
        connection: tenantId ? await (deps.connection ?? getTenantConnection)(tenantId) : null,
        notify: tenantId ? await (deps.notifyState ?? ((id: string) => getNotifyState(id)))(tenantId) : null,
        conciergeRequested: !!row.concierge_requested_at,
        noCodeConnect: NO_CODE_CONNECT,
        platform: isDetectedPlatform(row.detected_platform) ? row.detected_platform : null,
      },
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/* --------------------------------- step 2 --------------------------------- */

export type VerifyReason = "ok" | "unauthorized" | "already_verified" | "not_verified" | "rate_limited" | "provision_failed" | "error";
export interface VerifyResult {
  ok: boolean;
  reason: VerifyReason;
  /** Per-method failure reasons when not verified (coarse, never the token). */
  attempts?: { method: VerificationMethod; reason: string }[];
  tenant?: ForcefieldTenant;
  /** The ingest token, returned ONCE. */
  token?: string;
  quickstart?: TenantQuickstart;
  notify?: { status: "pending"; delivered: boolean; reason: string };
  method?: VerificationMethod;
  requestId?: string;
}

const METHODS: VerificationMethod[] = ["dns_txt", "http_well_known"];

export async function verifyOwnership(setupKey: string, deps: OnboardingDeps = {}): Promise<VerifyResult> {
  const q = deps.q ?? liveQuery;
  let row: OnboardingRow | null;
  try {
    row = await findOnboarding(setupKey, q);
  } catch {
    return { ok: false, reason: "error" };
  }
  if (!row) return { ok: false, reason: "unauthorized" };
  if (row.tenant_id || row.status !== "pending") return { ok: false, reason: "already_verified", requestId: row.id };

  try {
    const rl = await (deps.limiter ?? limiterFor("forcefield:onboard-verify", VERIFY_LIMIT, VERIFY_WINDOW_MS))(row.id);
    if (!rl.allowed) return { ok: false, reason: "rate_limited", requestId: row.id };
  } catch {
    return { ok: false, reason: "rate_limited", requestId: row.id };
  }

  // One click: try both proofs, DNS first (domain-wide), then the file.
  const check = deps.check ?? checkVerification;
  const platform = verificationPlatform(row.id);
  const site = row.site_url;
  const attempts: { method: VerificationMethod; reason: string }[] = [];
  let method: VerificationMethod | null = null;
  for (const m of METHODS) {
    try {
      const r = await runWithRequestWorkspace(ONBOARDING_WORKSPACE, () =>
        check(ONBOARDING_WORKSPACE, platform, m, { userId: platform, role: "public" }, { resolveBaseUrl: async () => `https://${site}` }),
      );
      if (r.ok) { method = m; break; }
      attempts.push({ method: m, reason: r.reason ?? "failed" });
    } catch {
      attempts.push({ method: m, reason: "check_error" });
    }
  }
  if (!method) return { ok: false, reason: "not_verified", attempts, requestId: row.id };

  try {
    // Claim the request so a double click provisions exactly one tenant.
    const claimed = await q<{ id: string }>(
      `UPDATE forcefield_signup_requests SET status = 'provisioning', updated_at = now()
        WHERE id = $1 AND status = 'pending' AND tenant_id IS NULL RETURNING id`,
      [row.id],
    );
    if (claimed.length === 0) return { ok: false, reason: "already_verified", requestId: row.id };

    const created = await (deps.provision ?? createForcefieldTenant)({ name: row.name, siteLabel: site, platform: connectorForPlatform(isDetectedPlatform(row.detected_platform) ? row.detected_platform : null) });
    if (!created) {
      await q(`UPDATE forcefield_signup_requests SET status = 'pending', updated_at = now() WHERE id = $1 RETURNING id`, [row.id]).catch(() => []);
      return { ok: false, reason: "provision_failed", requestId: row.id };
    }
    await q(
      `UPDATE forcefield_signup_requests
          SET status = 'approved', tenant_id = $2, reviewed_by = 'self_serve:ownership', reviewed_at = now(),
              ownership_method = $3, ownership_verified_at = now(), updated_at = now()
        WHERE id = $1 RETURNING id`,
      [row.id, created.tenant.id, method],
    );
    const sent = await (deps.notify ?? ((id: string, email: string) => setNotifyEmail(id, email)))(created.tenant.id, row.email);
    return {
      ok: true,
      reason: "ok",
      requestId: row.id,
      method,
      tenant: created.tenant,
      token: created.token,
      quickstart: buildTenantQuickstart(created.tenant, created.token),
      notify: { status: "pending", delivered: sent.delivered === true, reason: sent.ok ? sent.deliveryReason ?? "ok" : sent.reason },
    };
  } catch {
    return { ok: false, reason: "error", requestId: row.id };
  }
}

/* --------------------------------- step 3 --------------------------------- */

/** "We'll do it for you": record the connect request for the operator (shown on
 *  /admin/forcefield/signups). By setup key or by the tenant it provisioned. */
export async function requestConcierge(
  by: { setupKey: string } | { tenantId: string },
  note: unknown,
  q: TenantQuery = liveQuery,
): Promise<{ ok: boolean; reason: "ok" | "not_found" | "error"; requestId?: string }> {
  const text = String(note ?? "").trim().slice(0, 1000) || null;
  try {
    const rows = "setupKey" in by
      ? await q<{ id: string }>(
          `UPDATE forcefield_signup_requests SET concierge_requested_at = COALESCE(concierge_requested_at, now()),
                  concierge_note = COALESCE($2, concierge_note), updated_at = now()
            WHERE setup_key_sha256 = $1 AND kind = 'self_serve' RETURNING id`,
          [hashToken(String(by.setupKey ?? "").trim()), text],
        )
      : await q<{ id: string }>(
          `UPDATE forcefield_signup_requests SET concierge_requested_at = COALESCE(concierge_requested_at, now()),
                  concierge_note = COALESCE($2, concierge_note), updated_at = now()
            WHERE tenant_id = $1 RETURNING id`,
          [by.tenantId, text],
        );
    return rows.length ? { ok: true, reason: "ok", requestId: rows[0].id } : { ok: false, reason: "not_found" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
