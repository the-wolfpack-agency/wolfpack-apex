/**
 * Vercel integration provisioning - the one-click onboarding for a site on Vercel.
 *
 * When a client installs our Vercel integration and authorizes, Vercel redirects to
 * our callback with a short-lived `code`. This module exchanges that code for an
 * access token (Vercel's documented OAuth: POST /v2/oauth/access_token), mints a
 * Forcefield tenant, and writes the site's config straight into the project's
 * environment variables (POST /v10/projects/{id}/env) - so the client types NO
 * token and NO env by hand. The site key is written as a SENSITIVE var.
 *
 * Dark by default: unconfigured (no client id/secret) -> the callback is a no-op
 * 501, so merging this changes nothing until the integration is registered.
 *
 * Deterministic + no model client (safe inside the forcefield-web containment
 * boundary). All network I/O is injectable so the contract is unit-tested with no
 * real Vercel calls.
 *
 * Built to the documented contract:
 *   https://vercel.com/docs/integrations/create-integration/vercel-api-integrations
 *   https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables
 */
import { createForcefieldTenant, type TenantQuery } from "../tenants";

const OAUTH_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";
const PROJECT_ENV_URL = (projectId: string, teamId?: string) =>
  `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ""}`;

/** Injectable fetch so tests never hit the network. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** The integration is live only when its credentials are configured. Dark otherwise. */
export function isVercelIntegrationConfigured(): boolean {
  return !!(process.env.MARKETPLACE_VERCEL_CLIENT_ID && process.env.MARKETPLACE_VERCEL_CLIENT_SECRET);
}

/** The control-plane engine endpoint the provisioned site points at. */
function observeUrl(): string {
  const base = process.env.FORCEFIELD_PUBLIC_BASE_URL || "https://wolfpack-instinct.vercel.app";
  return `${base}/api/forcefield/observe`;
}

/** Exchange the one-time `code` for an access token (+ team id). Returns null on any
 *  failure - the caller surfaces a clean error and never throws. */
export async function exchangeVercelCode(
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike,
): Promise<{ accessToken: string; teamId?: string } | null> {
  const clientId = process.env.MARKETPLACE_VERCEL_CLIENT_ID || "";
  const clientSecret = process.env.MARKETPLACE_VERCEL_CLIENT_SECRET || "";
  if (!clientId || !clientSecret || !code) return null;
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }).toString();
  try {
    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: string; team_id?: string | null };
    if (!body.access_token) return null;
    return { accessToken: body.access_token, teamId: body.team_id ?? undefined };
  } catch {
    return null;
  }
}

/** Write one env var into the project. Returns false on any failure (never throws). */
export async function setVercelProjectEnv(
  accessToken: string,
  projectId: string,
  teamId: string | undefined,
  v: { key: string; value: string; sensitive?: boolean },
  fetchImpl: FetchLike,
): Promise<boolean> {
  try {
    const res = await fetchImpl(PROJECT_ENV_URL(projectId, teamId), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        key: v.key,
        value: v.value,
        type: v.sensitive ? "sensitive" : "plain",
        target: ["production", "preview", "development"],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface VercelProvisionInput {
  code: string;
  redirectUri: string;
  projectId: string;
  clientName: string;
  siteLabel: string;
}

export interface VercelProvisionResult {
  ok: boolean;
  reason?: "unconfigured" | "exchange_failed" | "tenant_failed" | "env_failed";
  tenantId?: string;
}

/**
 * The full one-click: exchange the code, mint a Forcefield tenant, and write the
 * site's config (watch-first) into the project's env. The site key is written as a
 * SENSITIVE var; the client never sees or types it. Watch-first: FORCEFIELD_ENFORCE
 * is "off" until the client turns blocking on from the console.
 */
export async function provisionVercelProject(
  input: VercelProvisionInput,
  deps: { fetchImpl: FetchLike; query?: TenantQuery },
): Promise<VercelProvisionResult> {
  if (!isVercelIntegrationConfigured()) return { ok: false, reason: "unconfigured" };

  const exchanged = await exchangeVercelCode(input.code, input.redirectUri, deps.fetchImpl);
  if (!exchanged) return { ok: false, reason: "exchange_failed" };

  const created = await createForcefieldTenant(
    { name: input.clientName, siteLabel: input.siteLabel, platform: "vercel" },
    deps.query,
  );
  if (!created) return { ok: false, reason: "tenant_failed" };

  const vars: { key: string; value: string; sensitive?: boolean }[] = [
    { key: "FORCEFIELD_WEB", value: "on" },
    { key: "FORCEFIELD_SITE", value: created.tenant.siteLabel },
    { key: "FORCEFIELD_INGEST_URL", value: observeUrl() },
    { key: "FORCEFIELD_ENFORCE", value: "off" }, // watch-first
    { key: "FORCEFIELD_EDGE_TOKEN", value: created.token, sensitive: true },
  ];
  for (const v of vars) {
    const ok = await setVercelProjectEnv(exchanged.accessToken, input.projectId, exchanged.teamId, v, deps.fetchImpl);
    if (!ok) return { ok: false, reason: "env_failed", tenantId: created.tenant.id };
  }
  return { ok: true, tenantId: created.tenant.id };
}
