/**
 * credentials.ts — per-tenant connector credential storage.
 *
 * Reads + writes instinct_connector_credentials (migration 136).
 * Encryption-at-rest for the auth_header via secret-storage.ts. A
 * row's absence falls back to env-var defaults so the single-
 * workspace path keeps working without any DB rows.
 *
 * Callers:
 *   loadConnectorCredentials(workspaceId, connectorName) → used by
 *     the connector factory at request time (or by a connector
 *     constructor that wants a workspace-aware build).
 *   saveConnectorCredentials(args) → admin-facing setter; encrypts
 *     auth_header before write, upserts on (workspace_id,
 *     connector_name).
 *   listConnectorCredentials(workspaceId) → admin UI list (mask
 *     auth_header so it never returns in plaintext).
 */

import { safeQuery } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";
import { trackEvent } from "@/lib/analytics";

export interface ConnectorCredentials {
  workspaceId: string;
  connectorName: string;
  baseUrl: string;
  /** PLAIN-TEXT auth header. Loaders decrypt before returning. */
  authHeader: string;
  /** Optional domain-object → URL-path map. */
  objectMap?: Record<string, string>;
  isActive: boolean;
  /** "static_bearer" for legacy / single-token rows, "oauth2" when the
   *  row is managed by the OAuth orchestrator (migration 138),
   *  "username_password" for form-login platforms (migration 181),
   *  "oauth_password" for OAuth2 Resource Owner Password platforms
   *  (Salesforce-style; migration 182). */
  authType: AuthType;
  /** When the cached access token expires. Null for static_bearer. */
  accessTokenExpiresAt: string | null;
  /** Auth endpoint path. Form-login path for username_password rows; the
   *  OAuth2 token endpoint for oauth_password rows. */
  loginPath?: string;
  /** Session cookie the platform sets on login. username_password only. */
  sessionCookieName?: string;
  /** Decoded username — server-side only, NEVER logged. Present for
   *  username_password rows (base64-decoded from the Basic auth header)
   *  and oauth_password rows (JSON-decoded from the credential blob). */
  username?: string;
  /** Decoded password — server-side only, NEVER logged. username_password
   *  + oauth_password only. */
  password?: string;
  /** OAuth2 Resource Owner Password client_id — server-side only, NEVER
   *  logged. oauth_password only (JSON-decoded from the credential blob). */
  clientId?: string;
  /** OAuth2 Resource Owner Password client_secret — server-side only,
   *  NEVER logged. oauth_password only. */
  clientSecret?: string;
}

/** Supported connector auth flows. Mirrors the auth_type CHECK constraint
 *  (migrations 138 + 181 + 182). */
export type AuthType =
  | "static_bearer"
  | "oauth2"
  | "username_password"
  | "oauth_password";

export interface MaskedConnectorCredentials {
  workspaceId: string;
  connectorName: string;
  baseUrl: string;
  /** Last 4 chars of the decrypted auth_header. UI-safe. */
  authHeaderHint: string;
  objectMap?: Record<string, string>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** "static_bearer", "oauth2", "username_password", or "oauth_password" —
   *  drives the admin UI badge that tells the operator which flow / whether
   *  refresh applies. Secrets are NEVER surfaced (only authHeaderHint's
   *  last-4 masking of the encrypted credential blob). */
  authType: AuthType;
  /** ISO timestamp when the cached access token expires (oauth2 only). */
  accessTokenExpiresAt: string | null;
  /** Auth endpoint path. Form-login path (username_password) or OAuth2
   *  token endpoint (oauth_password). */
  loginPath?: string;
  /** Session cookie name the platform sets (username_password only). */
  sessionCookieName?: string;
}

const DEFAULT_WORKSPACE = "default";

/**
 * Load credentials for (workspace, connectorName). Returns null when
 * no active row exists — caller should fall back to env defaults.
 */
export async function loadConnectorCredentials(
  workspaceId: string,
  connectorName: string,
): Promise<ConnectorCredentials | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const r = await safeQuery<{
      workspace_id: string;
      connector_name: string;
      base_url: string;
      auth_header_enc: string;
      object_map_json: string | null;
      is_active: boolean;
      auth_type: string | null;
      access_token_expires_at: string | null;
      login_path: string | null;
      session_cookie_name: string | null;
    }>(
      `SELECT workspace_id, connector_name, base_url, auth_header_enc,
              object_map_json, is_active, auth_type,
              access_token_expires_at::text AS access_token_expires_at,
              login_path, session_cookie_name
         FROM instinct_connector_credentials
        WHERE workspace_id = $1
          AND connector_name = $2
          AND is_active = TRUE
        LIMIT 1`,
      [workspaceId || DEFAULT_WORKSPACE, connectorName],
    );
    const row = r.rows[0];
    if (!row) return null;
    const authHeader = decryptSecret(row.auth_header_enc);
    if (authHeader === null) {
      /* Decrypt failed — surface as "no credentials" instead of
         returning garbage. Loud-via-analytics so a key rotation
         mismatch is immediately visible. */
      trackEvent("assistant.connector_credentials_decrypt_failed", "system", "system", {
        connector: connectorName,
        workspace_id: row.workspace_id,
      });
      return null;
    }
    const authType = normalizeAuthType(row.auth_type);
    const result: ConnectorCredentials = {
      workspaceId: row.workspace_id,
      connectorName: row.connector_name,
      baseUrl: row.base_url,
      authHeader,
      objectMap: parseObjectMap(row.object_map_json),
      isActive: row.is_active,
      authType,
      accessTokenExpiresAt: row.access_token_expires_at ?? null,
      loginPath: row.login_path ?? undefined,
      sessionCookieName: row.session_cookie_name ?? undefined,
    };
    if (authType === "username_password") {
      /* Decode the "Basic <base64(user:pass)>" header in-memory so the
         connector can replay the form login. These fields are
         server-side only and MUST NOT be logged. */
      const decoded = decodeBasicHeader(authHeader);
      if (decoded) {
        result.username = decoded.username;
        result.password = decoded.password;
      }
    } else if (authType === "oauth_password") {
      /* Decode the JSON credential blob in-memory so the connector can run
         the OAuth2 Resource Owner Password exchange (POST client_id +
         client_secret + username + password to login_path). These fields
         are server-side only and MUST NOT be logged. */
      const quad = decodeOAuthPasswordBlob(authHeader);
      if (quad) {
        result.clientId = quad.clientId;
        result.clientSecret = quad.clientSecret;
        result.username = quad.username;
        result.password = quad.password;
      }
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Upsert credentials for (workspace, connectorName). The auth_header
 * is encrypted before INSERT/UPDATE. Returns the masked view of the
 * stored row so the admin UI can confirm without a round-trip
 * decrypt.
 */
export async function saveConnectorCredentials(args: {
  workspaceId?: string;
  connectorName: string;
  baseUrl: string;
  /** Required for static_bearer / oauth2. Ignored for username_password
   *  (the Basic header is derived from username + password). */
  authHeader?: string;
  objectMap?: Record<string, string>;
  createdBy?: string;
  /** Defaults to "static_bearer" to preserve existing call sites. */
  authType?: AuthType;
  /** username_password + oauth_password — required together with password
   *  + loginPath. */
  username?: string;
  password?: string;
  loginPath?: string;
  sessionCookieName?: string;
  /** oauth_password only — required together with clientSecret + username +
   *  password + loginPath. */
  clientId?: string;
  clientSecret?: string;
}): Promise<MaskedConnectorCredentials | null> {
  if (!process.env.DATABASE_URL) return null;
  const workspaceId = args.workspaceId || DEFAULT_WORKSPACE;
  const authType: AuthType = args.authType ?? "static_bearer";

  /* Resolve the plaintext Authorization header we encrypt at rest. For
     username_password we encode "Basic base64(user:pass)" so the password
     reuses the existing encrypted column and never lands in plaintext.
     For every other flow, behave exactly as before. */
  let plaintextHeader: string;
  let loginPath: string | null = null;
  let sessionCookieName: string | null = null;
  if (authType === "username_password") {
    if (!args.username || !args.password || !args.loginPath) {
      /* Caller contract violation — the route validates this first, but
         fail-closed here too so a bad direct call can't persist a
         half-formed row. */
      return null;
    }
    plaintextHeader =
      "Basic " +
      Buffer.from(`${args.username}:${args.password}`, "utf8").toString("base64");
    loginPath = args.loginPath;
    sessionCookieName = args.sessionCookieName ?? null;
  } else if (authType === "oauth_password") {
    /* OAuth2 Resource Owner Password: store the credential quad as an
       encrypted JSON blob in auth_header_enc. No Basic header — the
       connector exchanges these four fields at login_path (the token
       endpoint) for a bearer + instance_url at request time. Fail-closed
       on any missing field so a bad direct call can't persist a
       half-formed row. */
    if (
      !args.clientId ||
      !args.clientSecret ||
      !args.username ||
      !args.password ||
      !args.loginPath
    ) {
      return null;
    }
    plaintextHeader = JSON.stringify({
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      username: args.username,
      password: args.password,
    });
    loginPath = args.loginPath;
    sessionCookieName = args.sessionCookieName ?? null;
  } else {
    if (!args.authHeader) return null;
    plaintextHeader = args.authHeader;
  }

  const enc = encryptSecret(plaintextHeader);
  const objectMapJson = args.objectMap ? JSON.stringify(args.objectMap) : null;
  try {
    const r = await safeQuery<{
      workspace_id: string;
      connector_name: string;
      base_url: string;
      object_map_json: string | null;
      is_active: boolean;
      created_at: string;
      updated_at: string;
      auth_type: string | null;
      login_path: string | null;
      session_cookie_name: string | null;
    }>(
      `INSERT INTO instinct_connector_credentials
         (workspace_id, connector_name, base_url, auth_header_enc,
          object_map_json, is_active, created_by,
          auth_type, login_path, session_cookie_name)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9)
       ON CONFLICT (workspace_id, connector_name)
       DO UPDATE SET
         base_url = EXCLUDED.base_url,
         auth_header_enc = EXCLUDED.auth_header_enc,
         object_map_json = EXCLUDED.object_map_json,
         is_active = TRUE,
         auth_type = EXCLUDED.auth_type,
         login_path = EXCLUDED.login_path,
         session_cookie_name = EXCLUDED.session_cookie_name,
         updated_at = now()
       RETURNING workspace_id, connector_name, base_url, object_map_json,
                 is_active, created_at::text, updated_at::text,
                 auth_type, login_path, session_cookie_name`,
      [
        workspaceId,
        args.connectorName,
        args.baseUrl,
        enc,
        objectMapJson,
        args.createdBy ?? null,
        authType,
        loginPath,
        sessionCookieName,
      ],
    );
    const row = r.rows[0];
    if (!row) return null;
    trackEvent("assistant.connector_credentials_updated", args.createdBy ?? "system", "system", {
      connector: args.connectorName,
      workspace_id: workspaceId,
    });
    return {
      workspaceId: row.workspace_id,
      connectorName: row.connector_name,
      baseUrl: row.base_url,
      /* Mask the header we actually persisted — for username_password
         this is the "Basic ****<last4>" of the encoded credential, so
         the password itself is never surfaced. */
      authHeaderHint: maskHeader(plaintextHeader),
      objectMap: parseObjectMap(row.object_map_json),
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      authType: normalizeAuthType(row.auth_type),
      accessTokenExpiresAt: null,
      loginPath: row.login_path ?? undefined,
      sessionCookieName: row.session_cookie_name ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Return the connector_name of the most useful active row for this
 *  workspace, or null when only the env-driven fallback applies.
 *
 *  Preference order:
 *    1. Vendor-specific OAuth rows (salesforce, hubspot, qbo, jira, …)
 *       — these have real per-tenant credentials AND a vendor preset
 *       objectMap so vendor REST paths work out of the box.
 *    2. rest-default OAuth row (generic OAuth deployment).
 *    3. Any other active row (legacy static_bearer).
 *
 *  Returns null when no row exists; callers fall back to the env-driven
 *  rest-default singleton.
 *
 *  Used by tools that want to pick the right connector automatically —
 *  e.g. when the user asks "look up contact id 003xxx" without naming
 *  Salesforce, we route to whatever's actually configured.
 */
export async function pickConfiguredConnector(
  workspaceId: string,
): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const r = await safeQuery<{ connector_name: string }>(
      `SELECT connector_name
         FROM instinct_connector_credentials
        WHERE workspace_id = $1
          AND is_active = TRUE
        ORDER BY
          CASE
            WHEN connector_name = 'rest-default' THEN 2
            ELSE 1
          END,
          connector_name`,
      [workspaceId || DEFAULT_WORKSPACE],
    );
    return r.rows[0]?.connector_name ?? null;
  } catch {
    return null;
  }
}

/** List active credentials for a workspace; auth_header is masked. */
export async function listConnectorCredentials(
  workspaceId: string = DEFAULT_WORKSPACE,
): Promise<MaskedConnectorCredentials[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const r = await safeQuery<{
      workspace_id: string;
      connector_name: string;
      base_url: string;
      auth_header_enc: string;
      object_map_json: string | null;
      is_active: boolean;
      created_at: string;
      updated_at: string;
      auth_type: string | null;
      access_token_expires_at: string | null;
      login_path: string | null;
      session_cookie_name: string | null;
    }>(
      `SELECT workspace_id, connector_name, base_url, auth_header_enc,
              object_map_json, is_active, created_at::text, updated_at::text,
              auth_type, access_token_expires_at::text AS access_token_expires_at,
              login_path, session_cookie_name
         FROM instinct_connector_credentials
        WHERE workspace_id = $1
        ORDER BY connector_name`,
      [workspaceId],
    );
    return r.rows.map((row) => {
      const decrypted = decryptSecret(row.auth_header_enc);
      return {
        workspaceId: row.workspace_id,
        connectorName: row.connector_name,
        baseUrl: row.base_url,
        authHeaderHint: maskHeader(decrypted ?? ""),
        objectMap: parseObjectMap(row.object_map_json),
        isActive: row.is_active,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        authType: normalizeAuthType(row.auth_type),
        accessTokenExpiresAt: row.access_token_expires_at ?? null,
        loginPath: row.login_path ?? undefined,
        sessionCookieName: row.session_cookie_name ?? undefined,
      };
    });
  } catch {
    return [];
  }
}

/** Coerce a raw DB auth_type string into the typed union. Unknown /
 *  null values fall back to "static_bearer" (the historical default). */
function normalizeAuthType(raw: string | null): AuthType {
  if (raw === "oauth2") return "oauth2";
  if (raw === "username_password") return "username_password";
  if (raw === "oauth_password") return "oauth_password";
  return "static_bearer";
}

/** Decode the oauth_password JSON credential blob back into its four
 *  fields. Returns null when the blob isn't well-formed. In-memory only —
 *  callers must never log the result. */
function decodeOAuthPasswordBlob(
  blob: string,
): { clientId: string; clientSecret: string; username: string; password: string } | null {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.clientSecret !== "string" ||
      typeof parsed.username !== "string" ||
      typeof parsed.password !== "string"
    ) {
      return null;
    }
    return {
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      username: parsed.username,
      password: parsed.password,
    };
  } catch {
    return null;
  }
}

/** Decode a "Basic <base64(user:pass)>" header back into its parts.
 *  Returns null when the header isn't a well-formed Basic credential.
 *  In-memory only — callers must never log the result. */
function decodeBasicHeader(
  header: string,
): { username: string; password: string } | null {
  const m = /^Basic\s+(.+)$/.exec(header);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return {
      username: decoded.slice(0, idx),
      password: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

function maskHeader(plaintext: string): string {
  if (!plaintext) return "(decrypt_failed)";
  /* oauth_password rows store a JSON credential blob, not a header. Never
     derive the hint from the blob (its tail leaks password chars) — return
     a constant, scheme-style hint that signals the flow without secrets. */
  if (plaintext.startsWith("{") && plaintext.includes('"clientId"')) {
    return "OAuthPassword ****";
  }
  /* "Bearer abc...xyz" — preserve scheme word, show last 4. */
  const parts = plaintext.split(/\s+/);
  if (parts.length === 2) {
    const [scheme, value] = parts;
    if (value.length <= 4) return `${scheme} ****`;
    return `${scheme} ****${value.slice(-4)}`;
  }
  if (plaintext.length <= 4) return "****";
  return `****${plaintext.slice(-4)}`;
}

function parseObjectMap(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
}
