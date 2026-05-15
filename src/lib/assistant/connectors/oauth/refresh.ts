/**
 * OAuth refresh + provisioning orchestrator.
 *
 * Two surface methods, both DB-side:
 *
 *   saveOAuthCredentials  — called from /callback after the user has
 *                            authorized the app. Writes auth_type=oauth2,
 *                            encrypted access + refresh tokens, the
 *                            expires_at boundary, and provider metadata.
 *
 *   refreshConnectorAccessToken — called from rest-connector when a
 *                            request returns 401. Loads the refresh
 *                            token, calls the provider, persists the
 *                            new tokens, and returns the new bearer.
 *
 * Both functions emit typed analytics so the learning loop sees every
 * authorization + refresh attempt and outcome — no data lost.
 *
 * Persistence semantics:
 *   - Access token + refresh token live encrypted (AES-256-GCM) in
 *     instinct_connector_credentials.
 *   - auth_header_enc holds "Bearer <access_token>" so the existing
 *     connector code reading authHeader keeps working.
 *   - When a provider rotates refresh tokens on refresh (HubSpot),
 *     we persist the new one; when it doesn't (Salesforce), we keep
 *     the prior token.
 */

import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";
import { getOAuthProvider } from "./registry";
import type {
  OAuthLifecycleResult,
  OAuthProvider,
  OAuthTokenResult,
} from "./types";

/** Conservative default when the provider doesn't tell us expiry.
 *  1 hour matches Salesforce defaults; HubSpot returns expires_in
 *  explicitly so this is only a fallback. */
const DEFAULT_ACCESS_TOKEN_TTL_SEC = 60 * 60;

/** Refresh proactively this many seconds before expiry to avoid a
 *  guaranteed 401-then-retry cycle on every request near the boundary. */
const REFRESH_LEAD_TIME_SEC = 60;

export interface PersistedOAuthRecord {
  workspaceId: string;
  connectorName: string;
  /** The CURRENT usable Authorization header value (with scheme). */
  authHeader: string;
  /** The provider-resolved API base URL (Salesforce instance_url,
   *  HubSpot static base, etc.) */
  baseUrl: string;
  expiresAt: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Persist tokens after a successful OAuth code exchange. Called from
 * /api/admin/connectors/oauth/[provider]/callback once we have the
 * provider's lifecycle result. Idempotent on (workspace_id, connector_name).
 */
export async function saveOAuthCredentials(args: {
  workspaceId: string;
  provider: OAuthProvider;
  token: OAuthTokenResult;
  createdBy?: string;
}): Promise<PersistedOAuthRecord | null> {
  if (!process.env.DATABASE_URL) return null;
  const { workspaceId, provider, token } = args;
  const tokenType = token.tokenType ?? "Bearer";
  const authHeader = `${tokenType} ${token.accessToken}`;
  const baseUrl = provider.buildBaseUrl(token.metadata);
  const expiresAtIso = token.expiresInSec
    ? new Date(Date.now() + token.expiresInSec * 1000).toISOString()
    : null;
  const metadata = token.metadata ?? null;

  const accessEnc = encryptSecret(authHeader);
  const refreshEnc = token.refreshToken ? encryptSecret(token.refreshToken) : null;

  try {
    await safeQuery(
      `INSERT INTO instinct_connector_credentials
         (workspace_id, connector_name, base_url, auth_header_enc,
          auth_type, refresh_token_enc, access_token_expires_at,
          oauth_provider_metadata, is_active, created_by)
       VALUES ($1, $2, $3, $4, 'oauth2', $5, $6, $7::jsonb, TRUE, $8)
       ON CONFLICT (workspace_id, connector_name)
       DO UPDATE SET
         base_url = EXCLUDED.base_url,
         auth_header_enc = EXCLUDED.auth_header_enc,
         auth_type = 'oauth2',
         refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, instinct_connector_credentials.refresh_token_enc),
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         oauth_provider_metadata = EXCLUDED.oauth_provider_metadata,
         is_active = TRUE,
         updated_at = now()`,
      [
        workspaceId,
        provider.connectorName,
        baseUrl,
        accessEnc,
        refreshEnc,
        expiresAtIso,
        metadata ? JSON.stringify(metadata) : null,
        args.createdBy ?? null,
      ],
    );
  } catch (err) {
    trackEvent("assistant.oauth_persist_failed", args.createdBy ?? "system", "system", {
      provider: provider.name,
      workspace_id: workspaceId,
      reason: (err as Error)?.message ?? "unknown",
    });
    return null;
  }

  trackEvent("assistant.oauth_authorization_completed", args.createdBy ?? "system", "system", {
    provider: provider.name,
    connector: provider.connectorName,
    workspace_id: workspaceId,
    expires_in_sec: token.expiresInSec ?? 0,
    refresh_token_present: Boolean(token.refreshToken),
  });

  return {
    workspaceId,
    connectorName: provider.connectorName,
    authHeader,
    baseUrl,
    expiresAt: expiresAtIso,
    metadata,
  };
}

/**
 * Refresh the access token for an OAuth-backed connector row.
 * Returns the fresh auth header on success; null when no row, no
 * refresh token, or provider rejected. Emits typed analytics for
 * every outcome.
 */
export async function refreshConnectorAccessToken(args: {
  workspaceId: string;
  connectorName: string;
  fetchImpl?: typeof fetch;
}): Promise<PersistedOAuthRecord | null> {
  if (!process.env.DATABASE_URL) return null;
  const { workspaceId, connectorName } = args;

  /* Load the OAuth row. Static_bearer rows can't be refreshed. */
  let row: {
    auth_type: string;
    refresh_token_enc: string | null;
    oauth_provider_metadata: unknown;
    base_url: string;
  } | undefined;
  try {
    const r = await safeQuery<{
      auth_type: string;
      refresh_token_enc: string | null;
      oauth_provider_metadata: unknown;
      base_url: string;
    }>(
      `SELECT auth_type, refresh_token_enc, oauth_provider_metadata, base_url
         FROM instinct_connector_credentials
        WHERE workspace_id = $1
          AND connector_name = $2
          AND is_active = TRUE
        LIMIT 1`,
      [workspaceId, connectorName],
    );
    row = r.rows[0];
  } catch {
    return null;
  }

  if (!row) return null;
  if (row.auth_type !== "oauth2") return null;
  if (!row.refresh_token_enc) {
    trackEvent("assistant.oauth_refresh_failed", "system", "system", {
      connector: connectorName,
      workspace_id: workspaceId,
      reason: "no_refresh_token",
    });
    return null;
  }
  const refreshToken = decryptSecret(row.refresh_token_enc);
  if (!refreshToken) {
    trackEvent("assistant.oauth_refresh_failed", "system", "system", {
      connector: connectorName,
      workspace_id: workspaceId,
      reason: "refresh_decrypt_failed",
    });
    return null;
  }

  /* Resolve provider by connector name. Convention: provider.name ==
     provider.connectorName for the providers we ship. If a future
     provider services multiple connector names, extend the registry. */
  const provider = getOAuthProvider(connectorName);
  if (!provider) {
    trackEvent("assistant.oauth_refresh_failed", "system", "system", {
      connector: connectorName,
      workspace_id: workspaceId,
      reason: "no_provider_in_registry",
    });
    return null;
  }

  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];
  if (!clientId || !clientSecret) {
    trackEvent("assistant.oauth_refresh_failed", "system", "system", {
      connector: connectorName,
      workspace_id: workspaceId,
      reason: "missing_client_credentials",
    });
    return null;
  }

  const result: OAuthLifecycleResult = await provider.refresh({
    clientId,
    clientSecret,
    refreshToken,
    fetchImpl: args.fetchImpl,
  });

  if (!result.ok) {
    trackEvent("assistant.oauth_refresh_failed", "system", "system", {
      connector: connectorName,
      workspace_id: workspaceId,
      reason: result.code,
      status: result.status ?? 0,
    });
    return null;
  }

  /* Provider may rotate the refresh token (HubSpot) or not (Salesforce).
     COALESCE in the UPDATE keeps the prior refresh token when the
     provider omits it. */
  const tokenType = result.tokenType ?? "Bearer";
  const newAuthHeader = `${tokenType} ${result.accessToken}`;
  const newAccessEnc = encryptSecret(newAuthHeader);
  const newRefreshEnc = result.refreshToken ? encryptSecret(result.refreshToken) : null;
  const expiresAtIso = result.expiresInSec
    ? new Date(Date.now() + result.expiresInSec * 1000).toISOString()
    : new Date(Date.now() + DEFAULT_ACCESS_TOKEN_TTL_SEC * 1000).toISOString();
  /* Merge metadata: keep whatever was previously stored, overlay any
     new fields the refresh returned (rare — typically just access
     fields rotate). */
  const priorMetadata =
    (row.oauth_provider_metadata as Record<string, unknown> | null) ?? null;
  const newMetadata: Record<string, unknown> | null = result.metadata
    ? { ...(priorMetadata ?? {}), ...result.metadata }
    : priorMetadata;
  const baseUrl = result.metadata
    ? provider.buildBaseUrl(newMetadata) || row.base_url
    : row.base_url;

  try {
    await safeQuery(
      `UPDATE instinct_connector_credentials
          SET auth_header_enc = $3,
              refresh_token_enc = COALESCE($4, refresh_token_enc),
              access_token_expires_at = $5,
              oauth_provider_metadata = COALESCE($6::jsonb, oauth_provider_metadata),
              base_url = $7,
              updated_at = now()
        WHERE workspace_id = $1
          AND connector_name = $2`,
      [
        workspaceId,
        connectorName,
        newAccessEnc,
        newRefreshEnc,
        expiresAtIso,
        newMetadata ? JSON.stringify(newMetadata) : null,
        baseUrl,
      ],
    );
  } catch (err) {
    trackEvent("assistant.oauth_refresh_failed", "system", "system", {
      connector: connectorName,
      workspace_id: workspaceId,
      reason: "persist_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
    return null;
  }

  trackEvent("assistant.oauth_token_refreshed", "system", "system", {
    connector: connectorName,
    workspace_id: workspaceId,
    expires_in_sec: result.expiresInSec ?? 0,
    refresh_token_rotated: Boolean(result.refreshToken),
  });

  return {
    workspaceId,
    connectorName,
    authHeader: newAuthHeader,
    baseUrl,
    expiresAt: expiresAtIso,
    metadata: newMetadata,
  };
}

/** True when the cached access token has fewer than REFRESH_LEAD_TIME_SEC
 *  seconds until it expires (or no expiry recorded). Exposed for the
 *  rest-connector's proactive-refresh path. */
export function shouldProactivelyRefresh(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const expMs = Date.parse(expiresAt);
  if (Number.isNaN(expMs)) return false;
  return expMs - Date.now() < REFRESH_LEAD_TIME_SEC * 1000;
}
