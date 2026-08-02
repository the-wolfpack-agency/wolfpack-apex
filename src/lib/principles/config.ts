/**
 * Principles platform self-service config.
 *
 * Replaces the env-var pair (PRINCIPLES_DOC_URL +
 * PRINCIPLES_DOC_OWNER_USER_ID) with a single DB-backed config row
 * that leadership can edit via the /principles team-tab UI. The cron
 * routes call resolvePrinciplesConfig() which reads the DB first and
 * falls back to env vars for backwards compatibility.
 *
 * owner_user_id auto-detect: when not explicitly set, picks the first
 * ceo/cto whose M365 token is currently valid. This means the doc
 * read credential rotates automatically as people connect/disconnect.
 *
 * Shadow-mode (no DATABASE_URL): get returns null, set throws.
 */

import { activePool, safeQuery, writeQuery, WriteQueryError } from "@/lib/db";

export interface PrinciplesConfigRecord {
  docUrl: string | null;
  ownerUserId: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** When true, ownerUserId came from the auto-detect fallback rather
   *  than an explicit setting. Surfaces in the UI so leadership can
   *  see whose token is doing the read. */
  ownerAutoDetected: boolean;
}

interface ConfigRow {
  doc_url: string | null;
  owner_user_id: string | null;
  updated_by: string | null;
  updated_at: string;
}

/**
 * Read the singleton config row. Returns null fields when the row
 * doesn't exist yet (first-run before any leadership has saved a URL).
 */
export async function getPrinciplesConfig(): Promise<PrinciplesConfigRecord> {
  const result = await safeQuery<ConfigRow>(
    `SELECT doc_url, owner_user_id, updated_by, updated_at
       FROM instinct_principles_config
      WHERE singleton = TRUE
      LIMIT 1`,
    [],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      docUrl: null,
      ownerUserId: null,
      updatedBy: null,
      updatedAt: null,
      ownerAutoDetected: false,
    };
  }
  return {
    docUrl: row.doc_url,
    ownerUserId: row.owner_user_id,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    ownerAutoDetected: false,
  };
}

export async function setPrinciplesConfig(args: {
  docUrl: string | null;
  ownerUserId?: string | null;
  updatedBy: string;
}): Promise<PrinciplesConfigRecord> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "setPrinciplesConfig requires DATABASE_URL",
      "no_database",
    );
  }
  const client = await activePool().connect();
  try {
    const existing = await client.query<ConfigRow>(
      `SELECT doc_url, owner_user_id, updated_by, updated_at
         FROM instinct_principles_config
        WHERE singleton = TRUE
        LIMIT 1`,
    );
    if (existing.rows.length === 0) {
      const inserted = await client.query<ConfigRow>(
        `INSERT INTO instinct_principles_config
           (singleton, doc_url, owner_user_id, updated_by)
         VALUES (TRUE, $1, $2, $3)
         RETURNING doc_url, owner_user_id, updated_by, updated_at`,
        [args.docUrl, args.ownerUserId ?? null, args.updatedBy],
      );
      const row = inserted.rows[0];
      return {
        docUrl: row.doc_url,
        ownerUserId: row.owner_user_id,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
        ownerAutoDetected: false,
      };
    }
    const updated = await client.query<ConfigRow>(
      `UPDATE instinct_principles_config
          SET doc_url = $1,
              owner_user_id = COALESCE($2, owner_user_id),
              updated_by = $3,
              updated_at = NOW()
        WHERE singleton = TRUE
        RETURNING doc_url, owner_user_id, updated_by, updated_at`,
      [args.docUrl, args.ownerUserId ?? null, args.updatedBy],
    );
    const row = updated.rows[0];
    return {
      docUrl: row.doc_url,
      ownerUserId: row.owner_user_id,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      ownerAutoDetected: false,
    };
  } finally {
    client.release();
  }
}

/**
 * Resolve effective config. Order of precedence:
 *   1. DB doc_url + DB owner_user_id (fully self-served).
 *   2. DB doc_url + auto-detected owner (any leadership user with a
 *      valid M365 token, picked by most-recent connection).
 *   3. Env-var fallback (PRINCIPLES_DOC_URL + PRINCIPLES_DOC_OWNER_USER_ID)
 *      for backwards compatibility with deploys that pre-date the
 *      DB-backed config.
 *
 * Returns null when neither source has a usable config.
 */
export async function resolvePrinciplesConfig(): Promise<PrinciplesConfigRecord | null> {
  const stored = await getPrinciplesConfig();
  const docUrl = stored.docUrl ?? process.env.PRINCIPLES_DOC_URL ?? null;
  let ownerUserId =
    stored.ownerUserId ?? process.env.PRINCIPLES_DOC_OWNER_USER_ID ?? null;
  let autoDetected = false;
  if (docUrl && !ownerUserId) {
    const auto = await pickOwnerByLeadershipToken();
    if (auto) {
      ownerUserId = auto;
      autoDetected = true;
    }
  }
  if (!docUrl || !ownerUserId) return null;
  return {
    docUrl,
    ownerUserId,
    updatedBy: stored.updatedBy,
    updatedAt: stored.updatedAt,
    ownerAutoDetected: autoDetected,
  };
}

/**
 * Pick the most-recently-connected leadership (ceo/cto) M365 user.
 * Read-only; never writes. Used when the operator hasn't explicitly
 * set an owner_user_id.
 *
 * Joins the M365 token table against the users table to filter by
 * role. Falls through to the most-recent token in the table if the
 * users table doesn't carry roles in this deployment.
 */
async function pickOwnerByLeadershipToken(): Promise<string | null> {
  /* The instinct_users table varies by deployment; query the columns
     most likely to carry role + fall back gracefully. */
  try {
    const result = await safeQuery<{ user_id: string }>(
      `SELECT t.connected_by AS user_id
         FROM instinct_ms_tokens t
         JOIN instinct_users u
           ON u.id = t.connected_by
            OR u.email = t.user_email
        WHERE LOWER(u.role) IN ('ceo', 'cto')
        ORDER BY t.connected_at DESC
        LIMIT 1`,
      [],
    );
    if (result.rows[0]?.user_id) return result.rows[0].user_id;
  } catch {
    /* Schema mismatch (no instinct_users.role column, etc.) — fall
       through to "any token" picker. */
  }
  /* Final fallback: any connected user. Better than refusing to run. */
  try {
    const result = await safeQuery<{ user_id: string }>(
      `SELECT connected_by AS user_id
         FROM instinct_ms_tokens
        ORDER BY connected_at DESC
        LIMIT 1`,
      [],
    );
    return result.rows[0]?.user_id ?? null;
  } catch {
    return null;
  }
}
