/**
 * Generic OAuth2 provider framework for connectors.
 *
 * Every provider (Salesforce, HubSpot, QuickBooks, Jira, GitHub, …)
 * implements `OAuthProvider`. The orchestrator (refresh.ts) and the
 * /api/admin/connectors/oauth/[provider]/{start,callback} routes are
 * provider-agnostic — they look up the provider in the registry and
 * call the three lifecycle methods.
 *
 * Why a framework, not vendor-specific code paths:
 *   1. Eliminates copy-pasting an OAuth flow per vendor (the 80% case
 *      is the same: authorize URL, code-for-token, refresh).
 *   2. New vendors plug in by adding ONE file in providers/ and one
 *      registry entry — no route changes.
 *   3. Lets the eval harness assert "refresh fires on 401" once,
 *      generically, instead of per provider.
 *
 * Boundaries:
 *   - Providers DO know their authorize / token URLs, scopes, and
 *     response-shape parsing.
 *   - Providers DO NOT know about workspaces, the DB, or analytics —
 *     the orchestrator owns persistence + telemetry.
 *   - Providers MAY emit instance-specific URLs via `metadata` (e.g.
 *     Salesforce `instance_url`) for the connector to use as baseUrl.
 */

/** Lifecycle output of a successful authorize-code or refresh-token
 *  exchange. Both flows return this shape so the orchestrator's
 *  persistence code doesn't fork. */
export interface OAuthTokenResult {
  /** Plain-text access token; the orchestrator encrypts before storing. */
  accessToken: string;
  /** Plain-text refresh token. Some providers (HubSpot) rotate the
   *  refresh token on every refresh; others (Salesforce, QBO) keep it
   *  stable. When the response omits it, the orchestrator preserves
   *  the existing stored refresh token. */
  refreshToken?: string;
  /** Seconds until access-token expiry. Providers that don't return
   *  this (some long-lived integrations) leave it undefined; the
   *  orchestrator falls back to a conservative 1-hour default. */
  expiresInSec?: number;
  /** Provider-specific JSON (Salesforce instance_url, QBO realm_id,
   *  HubSpot portal_id, …). Stored in oauth_provider_metadata. */
  metadata?: Record<string, unknown>;
  /** "Bearer" for most; some providers may return "MAC" or similar.
   *  Defaults to "Bearer" when undefined. */
  tokenType?: string;
}

/** Failure result for either lifecycle method. Discriminator on `ok`. */
export interface OAuthTokenError {
  ok: false;
  /** Coarse failure class for telemetry + UX routing. */
  code:
    | "invalid_grant"      // refresh token expired / revoked → re-auth required
    | "invalid_client"     // client_id/secret wrong
    | "network"            // fetch failed, no response
    | "remote_error"       // provider returned non-2xx with no recognized shape
    | "validation";        // shape failed our schema
  /** Human-readable detail (never user-controlled). */
  message: string;
  /** HTTP status from the provider when applicable. */
  status?: number;
}

export type OAuthLifecycleResult =
  | ({ ok: true } & OAuthTokenResult)
  | OAuthTokenError;

export interface OAuthProvider {
  /** Stable provider id, kebab-case. Same string callers pass to
   *  /api/admin/connectors/oauth/<name>/start. */
  name: string;
  /** Human-readable label for the admin UI. */
  label: string;
  /** Connector names this provider services (e.g. ["salesforce"]).
   *  When the orchestrator stores credentials, it writes them against
   *  this connector_name so loadConnectorCredentials picks them up. */
  connectorName: string;
  /** Env var that must hold the OAuth app's client_id. The route
   *  refuses to start the flow when this is unset. */
  clientIdEnv: string;
  clientSecretEnv: string;
  /** OAuth scopes requested. Provider-specific list; the orchestrator
   *  doesn't parse these. */
  scopes: string[];

  /** Build the URL the user is redirected to in step 1 (authorize).
   *  Implementations include client_id, redirect_uri, state, scopes,
   *  and any provider-specific flags. */
  buildAuthorizeUrl(args: {
    clientId: string;
    redirectUri: string;
    state: string;
  }): string;

  /** Exchange an authorization code for an access + refresh token. */
  exchangeCode(args: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    /** Override the default token URL — tests inject a fake here so
     *  the http call lands on a controllable mock. */
    fetchImpl?: typeof fetch;
  }): Promise<OAuthLifecycleResult>;

  /** Trade a refresh token for a fresh access token. */
  refresh(args: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    fetchImpl?: typeof fetch;
  }): Promise<OAuthLifecycleResult>;

  /** Build the API base URL from the provider metadata returned by
   *  exchangeCode/refresh. Salesforce uses metadata.instance_url;
   *  HubSpot uses a static base; QBO splices realm_id into the path. */
  buildBaseUrl(metadata: Record<string, unknown> | null | undefined): string;
}
