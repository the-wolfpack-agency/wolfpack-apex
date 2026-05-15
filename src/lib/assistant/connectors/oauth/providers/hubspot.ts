/**
 * HubSpot OAuth2 provider.
 *
 * Reference: https://developers.hubspot.com/docs/api/working-with-oauth
 *
 * Authorize:   GET  https://app.hubspot.com/oauth/authorize
 * Token:       POST https://api.hubapi.com/oauth/v1/token
 *              grant_type=authorization_code → access_token + refresh_token + expires_in
 *              grant_type=refresh_token      → access_token + (rotated) refresh_token + expires_in
 *
 * HubSpot rotates the refresh_token on every refresh (unlike Salesforce).
 * The orchestrator handles this — when refresh() returns a refreshToken
 * it gets persisted as the new one.
 *
 * baseUrl is always https://api.hubapi.com (no per-tenant instance URL).
 * The portal id is returned in token responses; we capture it in
 * metadata so future per-portal logic (rate-limit accounting, etc.) has
 * it available.
 */

import type {
  OAuthLifecycleResult,
  OAuthProvider,
  OAuthTokenResult,
} from "../types";

const HUBSPOT_AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_API_BASE = "https://api.hubapi.com";

interface HubSpotTokenResponseShape {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  hub_id?: number;
  user_id?: number;
}

interface HubSpotErrorShape {
  status?: string;
  message?: string;
  category?: string;
}

function parseTokenResponse(json: HubSpotTokenResponseShape): OAuthTokenResult | null {
  if (!json.access_token || typeof json.access_token !== "string") return null;
  const metadata: Record<string, unknown> = {};
  if (typeof json.hub_id === "number") metadata.hub_id = json.hub_id;
  if (typeof json.user_id === "number") metadata.user_id = json.user_id;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSec:
      typeof json.expires_in === "number" && json.expires_in > 0
        ? json.expires_in
        : undefined,
    tokenType: json.token_type ?? "Bearer",
    metadata,
  };
}

async function postToken(
  fetchImpl: typeof fetch,
  body: Record<string, string>,
): Promise<OAuthLifecycleResult> {
  let res: Response;
  try {
    res = await fetchImpl(HUBSPOT_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
    });
  } catch (err) {
    return {
      ok: false,
      code: "network",
      message: `hubspot token endpoint network error: ${(err as Error)?.message ?? "unknown"}`,
    };
  }
  let json: HubSpotTokenResponseShape & HubSpotErrorShape;
  try {
    json = (await res.json()) as HubSpotTokenResponseShape & HubSpotErrorShape;
  } catch {
    return {
      ok: false,
      code: "remote_error",
      message: "non-JSON response from hubspot token endpoint",
      status: res.status,
    };
  }
  if (!res.ok) {
    /* HubSpot error envelope: { status: "BAD_AUTH_TOKEN" | ..., message,
       category }. BAD_REFRESH_TOKEN signals refresh expired/revoked. */
    const status = json.status ?? "";
    if (status === "BAD_REFRESH_TOKEN" || status === "EXPIRED_AUTHENTICATION") {
      return {
        ok: false,
        code: "invalid_grant",
        message: json.message ?? "refresh token expired or revoked",
        status: res.status,
      };
    }
    if (status === "INVALID_CLIENT") {
      return {
        ok: false,
        code: "invalid_client",
        message: json.message ?? "client_id or client_secret rejected",
        status: res.status,
      };
    }
    return {
      ok: false,
      code: "remote_error",
      message: `hubspot token endpoint returned ${res.status}: ${json.message ?? ""}`,
      status: res.status,
    };
  }
  const parsed = parseTokenResponse(json);
  if (!parsed) {
    return {
      ok: false,
      code: "validation",
      message: "hubspot token response missing access_token",
      status: res.status,
    };
  }
  return { ok: true, ...parsed };
}

export const hubspotProvider: OAuthProvider = {
  name: "hubspot",
  label: "HubSpot",
  connectorName: "hubspot",
  clientIdEnv: "HUBSPOT_CLIENT_ID",
  clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
  /* Conservative read scopes for CRM objects. Real apps add more as
     features land. The orchestrator passes this list to authorize URL
     unchanged. */
  scopes: ["crm.objects.contacts.read", "crm.objects.deals.read", "crm.objects.companies.read"],

  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    const url = new URL(HUBSPOT_AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", hubspotProvider.scopes.join(" "));
    url.searchParams.set("state", state);
    /* HubSpot reuses an existing session by default — same UX risk as
       Salesforce. There's no documented `prompt=login`; the closest
       lever is the optional_scope parameter which we leave empty.
       Admins re-connecting a different portal sign out via HubSpot
       and try again. */
    return url.toString();
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl }) {
    return postToken(fetchImpl ?? fetch, {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });
  },

  async refresh({ clientId, clientSecret, refreshToken, fetchImpl }) {
    return postToken(fetchImpl ?? fetch, {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });
  },

  buildBaseUrl(_metadata) {
    return HUBSPOT_API_BASE;
  },
};
