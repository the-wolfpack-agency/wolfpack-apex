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
   *  row is managed by the OAuth orchestrator (migration 138). */
  authType: "static_bearer" | "oauth2";
  /** When the cached access token expires. Null for static_bearer. */
  accessTokenExpiresAt: string | null;
}

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
    }>(
      `SELECT workspace_id, connector_name, base_url, auth_header_enc,
              object_map_json, is_active, auth_type,
              access_token_expires_at::text AS access_token_expires_at
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
    return {
      workspaceId: row.workspace_id,
      connectorName: row.connector_name,
      baseUrl: row.base_url,
      authHeader,
      objectMap: parseObjectMap(row.object_map_json),
      isActive: row.is_active,
      authType: row.auth_type === "oauth2" ? "oauth2" : "static_bearer",
      accessTokenExpiresAt: row.access_token_expires_at ?? null,
    };
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
  authHeader: string;
  objectMap?: Record<string, string>;
  createdBy?: string;
}): Promise<MaskedConnectorCredentials | null> {
  if (!process.env.DATABASE_URL) return null;
  const workspaceId = args.workspaceId || DEFAULT_WORKSPACE;
  const enc = encryptSecret(args.authHeader);
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
    }>(
      `INSERT INTO instinct_connector_credentials
         (workspace_id, connector_name, base_url, auth_header_enc,
          object_map_json, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6)
       ON CONFLICT (workspace_id, connector_name)
       DO UPDATE SET
         base_url = EXCLUDED.base_url,
         auth_header_enc = EXCLUDED.auth_header_enc,
         object_map_json = EXCLUDED.object_map_json,
         is_active = TRUE,
         updated_at = now()
       RETURNING workspace_id, connector_name, base_url, object_map_json,
                 is_active, created_at::text, updated_at::text`,
      [
        workspaceId,
        args.connectorName,
        args.baseUrl,
        enc,
        objectMapJson,
        args.createdBy ?? null,
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
      authHeaderHint: maskHeader(args.authHeader),
      objectMap: parseObjectMap(row.object_map_json),
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
    }>(
      `SELECT workspace_id, connector_name, base_url, auth_header_enc,
              object_map_json, is_active, created_at::text, updated_at::text
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
      };
    });
  } catch {
    return [];
  }
}

function maskHeader(plaintext: string): string {
  if (!plaintext) return "(decrypt_failed)";
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
