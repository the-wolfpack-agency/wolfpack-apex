/**
 * Salesforce OAuth2 provider.
 *
 * Reference: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm
 *
 * Authorize:   GET  https://login.salesforce.com/services/oauth2/authorize
 *              (login.salesforce.com for production; test.salesforce.com for sandboxes —
 *               override via SALESFORCE_AUTH_HOST env var when a tenant uses a sandbox).
 * Token:       POST https://<authhost>/services/oauth2/token
 *              grant_type=authorization_code → returns access_token + refresh_token + instance_url.
 *              grant_type=refresh_token      → returns access_token (+ sometimes new refresh_token).
 *
 * The instance_url returned in the token response is the per-org API host
 * (e.g. https://acme.my.salesforce.com). buildBaseUrl returns it so the
 * REST connector sends every subsequent request to the right org.
 */

import type {
  OAuthLifecycleResult,
  OAuthProvider,
  OAuthTokenResult,
} from "../types";

const DEFAULT_HOST = "https://login.salesforce.com";

function authHost(): string {
  return (process.env.SALESFORCE_AUTH_HOST || DEFAULT_HOST).replace(/\/$/, "");
}

interface SalesforceTokenResponseShape {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  id?: string;
  token_type?: string;
  issued_at?: string;
  signature?: string;
  scope?: string;
  /** Salesforce doesn't return expires_in by default; orgs must opt in
   *  via "Token Endpoint Expiration" custom setting. Treat as
   *  potentially undefined. */
  expires_in?: number;
}

function parseTokenResponse(json: SalesforceTokenResponseShape): OAuthTokenResult | null {
  if (!json.access_token || typeof json.access_token !== "string") return null;
  const metadata: Record<string, unknown> = {};
  if (json.instance_url) metadata.instance_url = json.instance_url;
  if (json.id) metadata.user_identity_url = json.id;
  if (json.scope) metadata.scope = json.scope;
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
  const url = `${authHost()}/services/oauth2/token`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
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
      message: `salesforce token endpoint network error: ${(err as Error)?.message ?? "unknown"}`,
    };
  }
  let json: SalesforceTokenResponseShape;
  try {
    json = (await res.json()) as SalesforceTokenResponseShape;
  } catch {
    return {
      ok: false,
      code: "remote_error",
      message: "non-JSON response from salesforce token endpoint",
      status: res.status,
    };
  }
  if (!res.ok) {
    /* Salesforce error envelope: { error, error_description }. Map the
       two most actionable codes; everything else lumps into remote_error
       so analytics can pivot on coarse class. */
    const errCode = (json as unknown as { error?: string }).error;
    if (errCode === "invalid_grant") {
      return {
        ok: false,
        code: "invalid_grant",
        message:
          (json as unknown as { error_description?: string }).error_description ??
          "refresh token expired or revoked",
        status: res.status,
      };
    }
    if (errCode === "invalid_client" || errCode === "invalid_client_id") {
      return {
        ok: false,
        code: "invalid_client",
        message:
          (json as unknown as { error_description?: string }).error_description ??
          "client_id or client_secret rejected",
        status: res.status,
      };
    }
    return {
      ok: false,
      code: "remote_error",
      message: `salesforce token endpoint returned ${res.status}`,
      status: res.status,
    };
  }
  const parsed = parseTokenResponse(json);
  if (!parsed) {
    return {
      ok: false,
      code: "validation",
      message: "salesforce token response missing access_token",
      status: res.status,
    };
  }
  return { ok: true, ...parsed };
}

export const salesforceProvider: OAuthProvider = {
  name: "salesforce",
  label: "Salesforce",
  connectorName: "salesforce",
  clientIdEnv: "SALESFORCE_CLIENT_ID",
  clientSecretEnv: "SALESFORCE_CLIENT_SECRET",
  /* api is required for REST access; refresh_token is required for the
     refresh flow (without it Salesforce won't issue one); offline_access
     is sometimes also required depending on Connected App settings. */
  scopes: ["api", "refresh_token", "offline_access"],

  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    const url = new URL(`${authHost()}/services/oauth2/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", salesforceProvider.scopes.join(" "));
    url.searchParams.set("state", state);
    /* `prompt=login` forces a fresh sign-in so a user with multiple
       Salesforce orgs can pick which one to connect. Without it, SF
       silently reuses an existing browser session — bad UX when the
       admin meant to connect a different org. */
    url.searchParams.set("prompt", "login");
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

  buildBaseUrl(metadata) {
    const url = (metadata?.instance_url as string | undefined) ?? "";
    if (!url) return "";
    return url.replace(/\/$/, "");
  },
};
