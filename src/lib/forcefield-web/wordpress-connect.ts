/**
 * Forcefield WordPress CONNECT: the plugin connects the site itself. No key to
 * copy, no DNS record, no file upload.
 *
 *   1. start   The owner clicks Connect in the plugin. The plugin generates a
 *              random secret (ffp_...) and sends it with the site address
 *              (home_url) and the alert email. We store only the secret's
 *              SHA-256 on a self-serve signup request and issue a server-side
 *              challenge (the platform-scan issueVerificationToken, in the
 *              onboarding workspace), which the plugin stores and serves.
 *   2. prove   The plugin asks us to check. We fetch the plugin's challenge
 *              endpoint ON THE SITE ITSELF (/?rest_route=/ogiam-forcefield/v1/challenge),
 *              through the SSRF guard, and compare in constant time. Code
 *              running on the site answering the challenge we issued is the
 *              ownership proof for this path (ownership_method 'wordpress_plugin');
 *              it replaces the DNS TXT / file step, which stays available for
 *              every other path. Proof provisions the tenant and sends the
 *              existing confirmation email (setNotifyEmail).
 *   3. claim   The owner clicks the sign-in link in that email, which confirms
 *              the address (and signs the browser in to the dashboard). Only
 *              then will a claim with the plugin's secret return the site key,
 *              exactly once (a fresh key via rotateTenantToken; the key minted
 *              at provisioning was never handed to anyone).
 *
 * BUILD PHASE: an address outside the recipient allowlist is filed in the
 * operator-reviewed request queue and sent nothing, the same rule as
 * startForcefieldOnboarding.
 *
 * Deterministic (no model client). Injectable deps; never throws into a route.
 */
import { timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";
import { runWithRequestWorkspace } from "@/lib/db/request-workspace";
import { issueVerificationToken } from "@/lib/platform-scan/authorization";
import { createForcefieldTenant, hashToken, rotateTenantToken, type TenantQuery } from "@/lib/forcefield-web/tenants";
import { createSignupRequest, normalizeSite } from "@/lib/forcefield-web/signup";
import { isRecipientAllowed } from "@/lib/forcefield-web/recipient-allowlist";
import { maskEmail, normalizeEmail, setNotifyEmail, type SetNotifyResult } from "@/lib/forcefield-web/tenant-notify";
import { ONBOARDING_WORKSPACE, verificationPlatform, loadChallenge, limiterFor, type Limiter, START_LIMIT, START_WINDOW_MS, VERIFY_LIMIT, VERIFY_WINDOW_MS } from "@/lib/forcefield-web/onboarding";
import { assertSiteFetchable, siteOrigin } from "@/lib/forcefield-web/platform-detect";

/** The plugin's REST route that serves the pending challenge. */
export const PLUGIN_CHALLENGE_ROUTE = "/ogiam-forcefield/v1/challenge";
export const OWNERSHIP_METHOD = "wordpress_plugin";
export const CLAIM_LIMIT = 120;
export const CLAIM_WINDOW_MS = 60 * 60 * 1000;
const SECRET_RE = /^ffp_[A-Za-z0-9_-]{32,128}$/;
const CHALLENGE_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;

export const isPluginSecret = (v: unknown): v is string => typeof v === "string" && SECRET_RE.test(v);

/** The URL the plugin serves its challenge at. The plain-permalink form works on
 *  every WordPress install, with or without pretty permalinks. */
export function challengeUrl(site: string): string {
  return `${siteOrigin(site)}/?rest_route=${encodeURIComponent(PLUGIN_CHALLENGE_ROUTE)}`;
}

const liveQuery: TenantQuery = async (sql, params) => (await query(sql, params ?? [])).rows as never;
const issueLive = (ws: string, platform: string) => runWithRequestWorkspace(ws, () => issueVerificationToken(ws, platform));

export interface ConnectDeps {
  q?: TenantQuery;
  limiter?: Limiter;
  issue?: (workspaceId: string, platform: string) => Promise<{ token: string }>;
  challenge?: (requestId: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  guard?: (url: string) => Promise<void>;
  provision?: typeof createForcefieldTenant;
  notify?: (tenantId: string, email: string) => Promise<SetNotifyResult>;
  rotate?: typeof rotateTenantToken;
  fallbackRequest?: typeof createSignupRequest;
}

interface PluginRow {
  id: string;
  name: string;
  email: string;
  site_url: string;
  status: string;
  tenant_id: string | null;
  plugin_linked_at: string | null;
}

async function rowBySecret(secret: string, q: TenantQuery): Promise<PluginRow | null> {
  const [row] = await q<PluginRow>(
    `SELECT id, name, email, site_url, status, tenant_id, plugin_linked_at::text AS plugin_linked_at
       FROM forcefield_signup_requests
      WHERE plugin_secret_sha256 = $1 AND kind = 'self_serve'
      LIMIT 1`,
    [hashToken(secret)],
  );
  return row ?? null;
}

function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/* --------------------------------- start ---------------------------------- */

export type StartConnectReason = "ok" | "request" | "invalid" | "rate_limited" | "error";
export interface StartConnectResult {
  ok: boolean;
  reason: StartConnectReason;
  requestId?: string;
  site?: string;
  /** The server-issued challenge the plugin stores and serves. */
  challenge?: string;
}

export async function startPluginConnect(input: { raw: Record<string, unknown>; ipHash: string }, deps: ConnectDeps = {}): Promise<StartConnectResult> {
  const site = normalizeSite(String(input.raw.site ?? ""));
  const email = normalizeEmail(input.raw.email);
  const secret = input.raw.secret;
  if (!site || !email || !isPluginSecret(secret)) return { ok: false, reason: "invalid" };
  const nameRaw = String(input.raw.name ?? "").trim().slice(0, 200);
  const name = nameRaw.length >= 2 ? nameRaw : site;
  try {
    const limiter = deps.limiter ?? limiterFor("forcefield:wp-connect", START_LIMIT, START_WINDOW_MS);
    const [byIp, bySite] = await Promise.all([limiter(`ip:${input.ipHash}`), limiter(`site:${site}`)]);
    if (!byIp.allowed || !bySite.allowed) return { ok: false, reason: "rate_limited" };
  } catch {
    return { ok: false, reason: "rate_limited" };
  }

  // Build phase: anyone outside the allowlist is filed for operator review.
  if (!isRecipientAllowed(email)) {
    const r = await (deps.fallbackRequest ?? createSignupRequest)(
      { raw: { name, email, siteUrl: site, note: "Connect requested from the WordPress plugin" }, ipHash: input.ipHash },
      undefined,
      async () => ({ allowed: true }),
    );
    if (r.reason === "invalid") return { ok: false, reason: "invalid" };
    if (r.reason === "error") return { ok: false, reason: "error" };
    return { ok: true, reason: "request", requestId: r.requestId, site };
  }

  const q = deps.q ?? liveQuery;
  try {
    // A second Connect for the same open site + email (a reinstall, a retry)
    // replaces the plugin secret; the new challenge must be proven again.
    const [row] = await q<{ id: string }>(
      `INSERT INTO forcefield_signup_requests (name, email, site_url, note, ip_hash, kind, detected_platform, plugin_secret_sha256)
       VALUES ($1, $2, $3, 'Connected from the WordPress plugin', $4, 'self_serve', 'wordpress', $5)
       ON CONFLICT (lower(email), lower(site_url)) WHERE status = 'pending'
       DO UPDATE SET plugin_secret_sha256 = EXCLUDED.plugin_secret_sha256, kind = 'self_serve',
                     detected_platform = 'wordpress', updated_at = now()
       RETURNING id`,
      [name, email, site, input.ipHash, hashToken(secret)],
    );
    if (!row) return { ok: false, reason: "error" };
    const issued = await (deps.issue ?? issueLive)(ONBOARDING_WORKSPACE, verificationPlatform(row.id));
    return { ok: true, reason: "ok", requestId: row.id, site, challenge: issued.token };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/* --------------------------------- prove ---------------------------------- */

/** Fetch the plugin's challenge answer from the site, through the SSRF guard on
 *  every hop. A redirect is followed only to the same host (or its www form). */
export async function fetchPluginChallenge(site: string, deps: Pick<ConnectDeps, "fetchImpl" | "guard"> = {}): Promise<{ ok: true; challenge: string } | { ok: false; reason: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const host = (h: string) => h.toLowerCase().replace(/^www\./, "");
  const want = host(new URL(siteOrigin(site)).host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHALLENGE_TIMEOUT_MS);
  try {
    let url = challengeUrl(site);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        await assertSiteFetchable(url, deps.guard);
      } catch {
        return { ok: false, reason: "ssrf_blocked" };
      }
      const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, reason: "redirect_without_location" };
        const next = new URL(loc, url);
        if (host(next.host) !== want || (next.protocol !== "https:" && next.protocol !== "http:")) return { ok: false, reason: "redirect_off_site" };
        url = next.toString();
        continue;
      }
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      const body = (await res.json().catch(() => null)) as { challenge?: unknown } | null;
      if (!body || typeof body.challenge !== "string" || !body.challenge) return { ok: false, reason: "no_challenge" };
      return { ok: true, challenge: body.challenge.slice(0, 256) };
    }
    return { ok: false, reason: "too_many_redirects" };
  } catch (err) {
    return { ok: false, reason: (err as Error)?.name === "AbortError" ? "timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export type ProveReason = "ok" | "invalid" | "unauthorized" | "already_verified" | "not_verified" | "rate_limited" | "provision_failed" | "error";
export interface ProveResult {
  ok: boolean;
  reason: ProveReason;
  requestId?: string;
  tenantId?: string;
  site?: string;
  /** Coarse failure reason (never the challenge). */
  detail?: string;
  /** Where the sign-in link went, masked. */
  emailMasked?: string;
  delivered?: boolean;
}

export async function provePluginConnect(secret: unknown, deps: ConnectDeps = {}): Promise<ProveResult> {
  if (!isPluginSecret(secret)) return { ok: false, reason: "invalid" };
  const q = deps.q ?? liveQuery;
  let row: PluginRow | null;
  try {
    row = await rowBySecret(secret, q);
  } catch {
    return { ok: false, reason: "error" };
  }
  if (!row) return { ok: false, reason: "unauthorized" };
  if (row.tenant_id || row.status !== "pending") {
    return { ok: false, reason: "already_verified", requestId: row.id, tenantId: row.tenant_id ?? undefined, site: row.site_url, emailMasked: maskEmail(row.email) };
  }
  try {
    const rl = await (deps.limiter ?? limiterFor("forcefield:wp-prove", VERIFY_LIMIT, VERIFY_WINDOW_MS))(row.id);
    if (!rl.allowed) return { ok: false, reason: "rate_limited", requestId: row.id };
  } catch {
    return { ok: false, reason: "rate_limited", requestId: row.id };
  }

  const r = row;
  const expected = await (deps.challenge ?? ((id: string) => runWithRequestWorkspace(ONBOARDING_WORKSPACE, () => loadChallenge(id, q))))(r.id).catch(() => null);
  if (!expected) return { ok: false, reason: "not_verified", requestId: r.id, detail: "no_token_issued" };
  const got = await fetchPluginChallenge(r.site_url, deps);
  if (!got.ok) return { ok: false, reason: "not_verified", requestId: r.id, detail: got.reason };
  if (!tokensMatch(got.challenge, expected)) return { ok: false, reason: "not_verified", requestId: r.id, detail: "token_mismatch" };

  try {
    // Claim the request so a double click provisions exactly one tenant.
    const claimed = await q<{ id: string }>(
      `UPDATE forcefield_signup_requests SET status = 'provisioning', updated_at = now()
        WHERE id = $1 AND status = 'pending' AND tenant_id IS NULL RETURNING id`,
      [r.id],
    );
    if (claimed.length === 0) return { ok: false, reason: "already_verified", requestId: r.id };
    const created = await (deps.provision ?? createForcefieldTenant)({ name: r.name, siteLabel: r.site_url, platform: "wordpress" });
    if (!created) {
      await q(`UPDATE forcefield_signup_requests SET status = 'pending', updated_at = now() WHERE id = $1 RETURNING id`, [r.id]).catch(() => []);
      return { ok: false, reason: "provision_failed", requestId: r.id };
    }
    await q(
      `UPDATE forcefield_signup_requests
          SET status = 'approved', tenant_id = $2, reviewed_by = 'self_serve:wordpress_plugin', reviewed_at = now(),
              ownership_method = $3, ownership_verified_at = now(), updated_at = now()
        WHERE id = $1 RETURNING id`,
      [r.id, created.tenant.id, OWNERSHIP_METHOD],
    );
    // Record the proof on the challenge row too, so the verification record says
    // how this site was proven (never the token).
    await runWithRequestWorkspace(ONBOARDING_WORKSPACE, () =>
      q(
        `UPDATE instinct_target_verifications
            SET verification_status = 'verified', verification_method = $3, verified_at = now(), verification_reason = NULL, updated_at = now()
          WHERE workspace_id = $1 AND platform = $2 RETURNING platform`,
        [ONBOARDING_WORKSPACE, verificationPlatform(r.id), OWNERSHIP_METHOD],
      ),
    ).catch(() => []);
    const sent = await (deps.notify ?? ((id: string, email: string) => setNotifyEmail(id, email)))(created.tenant.id, r.email);
    return {
      ok: true,
      reason: "ok",
      requestId: r.id,
      tenantId: created.tenant.id,
      site: r.site_url,
      emailMasked: maskEmail(r.email),
      delivered: sent.ok && sent.delivered === true,
    };
  } catch {
    return { ok: false, reason: "error", requestId: r.id };
  }
}

/* --------------------------------- claim ---------------------------------- */

export type ClaimReason = "ok" | "invalid" | "unauthorized" | "not_verified" | "awaiting_confirmation" | "already_linked" | "rate_limited" | "error";
export interface ClaimResult {
  ok: boolean;
  reason: ClaimReason;
  requestId?: string;
  tenantId?: string;
  site?: string;
  /** The site key, returned exactly once. */
  token?: string;
  emailMasked?: string;
}

export async function claimPluginToken(secret: unknown, deps: ConnectDeps = {}): Promise<ClaimResult> {
  if (!isPluginSecret(secret)) return { ok: false, reason: "invalid" };
  const q = deps.q ?? liveQuery;
  try {
    const row = await rowBySecret(secret, q);
    if (!row) return { ok: false, reason: "unauthorized" };
    const base = { requestId: row.id, site: row.site_url, emailMasked: maskEmail(row.email) };
    if (!row.tenant_id) return { ok: false, reason: "not_verified", ...base };
    if (row.plugin_linked_at) return { ok: false, reason: "already_linked", ...base, tenantId: row.tenant_id };
    // The plugin polls this until the link is clicked: a generous per-request cap.
    const rl = await (deps.limiter ?? limiterFor("forcefield:wp-claim", CLAIM_LIMIT, CLAIM_WINDOW_MS))(row.id);
    if (!rl.allowed) return { ok: false, reason: "rate_limited", ...base };
    const [t] = await q<{ notify_status: string | null }>(
      `SELECT notify_status FROM forcefield_tenants WHERE id = $1 AND status = 'active' LIMIT 1`,
      [row.tenant_id],
    );
    if (!t) return { ok: false, reason: "unauthorized", ...base };
    if (t.notify_status !== "confirmed") return { ok: false, reason: "awaiting_confirmation", ...base, tenantId: row.tenant_id };
    // Exactly once: the first claim after confirmation wins.
    const linked = await q<{ id: string }>(
      `UPDATE forcefield_signup_requests SET plugin_linked_at = now(), updated_at = now()
        WHERE id = $1 AND plugin_linked_at IS NULL RETURNING id`,
      [row.id],
    );
    if (linked.length === 0) return { ok: false, reason: "already_linked", ...base, tenantId: row.tenant_id };
    const rotated = await (deps.rotate ?? rotateTenantToken)(row.tenant_id);
    if (!rotated) {
      await q(`UPDATE forcefield_signup_requests SET plugin_linked_at = NULL WHERE id = $1 RETURNING id`, [row.id]).catch(() => []);
      return { ok: false, reason: "error", ...base };
    }
    return { ok: true, reason: "ok", ...base, tenantId: row.tenant_id, token: rotated.token };
  } catch {
    return { ok: false, reason: "error" };
  }
}
