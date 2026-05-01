/**
 * Per-user dashboard left-nav preferences.
 *
 * Stores an array of hidden hrefs for each user so they can de-clutter
 * the sidebar without affecting anyone else. The hrefs are validated
 * against the canonical NAV list (defined in (dashboard)/layout.tsx)
 * before persistence so a typo can't permanently hide nothing.
 *
 * Shadow-mode behavior (no DATABASE_URL):
 *   - get returns { hiddenHrefs: [] } (everyone sees the full nav).
 *   - set throws WriteQueryError so callers know writes aren't durable.
 */

import { pool, safeQuery, WriteQueryError } from "@/lib/db";

export interface UserNavPrefs {
  userId: string;
  hiddenHrefs: string[];
  updatedAt: string;
}

interface NavPrefsRow {
  user_id: string;
  hidden_hrefs: string[];
  updated_at: string;
}

const SELECT_COLS = "user_id, hidden_hrefs, updated_at";

/**
 * Canonical set of nav hrefs. Must match the NAV_ITEMS array in
 * src/app/(dashboard)/layout.tsx — keeping this list here lets the
 * validator + the API reject hrefs that don't exist in the UI without
 * importing client-only modules. The list is asserted against the
 * layout in src/lib/__tests__/user-nav-prefs.test.ts.
 */
export const KNOWN_NAV_HREFS: readonly string[] = [
  "/assistant",
  "/",
  "/search",
  "/emails",
  "/messages",
  "/calendar",
  "/knowledge",
  "/meetings/feeds",
  "/tasks",
  "/goals",
  "/journal",
  "/features",
  "/discussions",
  "/bulletin",
  "/docs",
  "/reports",
  "/clients",
  "/sites",
  "/hr",
  "/financials",
  "/analytics",
  "/tools",
  "/qr",
  "/automations",
  "/support",
  "/settings",
];

/**
 * The Dashboard ('/') is non-hideable — every user must keep at least
 * one safe entry point so they can recover if they accidentally hide
 * the rest. Settings is also pinned because it's the only place to
 * un-hide things from. The UI greys these out; this guard enforces it
 * server-side too.
 */
export const PINNED_HREFS: readonly string[] = ["/", "/settings"];

export function validateHiddenHrefs(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new Error("hiddenHrefs must be an array");
  }
  const cleaned: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") {
      throw new Error("hiddenHrefs entries must be strings");
    }
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (!KNOWN_NAV_HREFS.includes(trimmed)) {
      throw new Error(`unknown nav href: ${trimmed}`);
    }
    if (PINNED_HREFS.includes(trimmed)) {
      throw new Error(`cannot hide pinned nav href: ${trimmed}`);
    }
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  return cleaned;
}

function rowToPrefs(row: NavPrefsRow): UserNavPrefs {
  return {
    userId: row.user_id,
    hiddenHrefs: Array.isArray(row.hidden_hrefs) ? row.hidden_hrefs : [],
    updatedAt: row.updated_at,
  };
}

export async function getNavPrefs(userId: string): Promise<UserNavPrefs> {
  if (!userId) {
    return {
      userId: "",
      hiddenHrefs: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
  const result = await safeQuery<NavPrefsRow>(
    `SELECT ${SELECT_COLS} FROM instinct_user_nav_prefs WHERE user_id = $1`,
    [userId],
  );
  if (result.rows[0]) return rowToPrefs(result.rows[0]);
  /* No row yet = default visibility. Return an unsaved object so
     callers don't have to special-case null. */
  return {
    userId,
    hiddenHrefs: [],
    updatedAt: new Date(0).toISOString(),
  };
}

export async function setNavPrefs(
  userId: string,
  hiddenHrefs: string[],
): Promise<UserNavPrefs> {
  if (!process.env.DATABASE_URL) {
    throw new WriteQueryError(
      "setNavPrefs requires DATABASE_URL",
      "no_database",
    );
  }
  if (!userId) throw new Error("userId is required");
  const cleaned = validateHiddenHrefs(hiddenHrefs);

  const client = await pool.connect();
  try {
    const result = await client.query<NavPrefsRow>(
      `INSERT INTO instinct_user_nav_prefs (user_id, hidden_hrefs, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
         DO UPDATE SET hidden_hrefs = EXCLUDED.hidden_hrefs,
                       updated_at   = NOW()
       RETURNING ${SELECT_COLS}`,
      [userId, cleaned],
    );
    if (result.rows.length !== 1) {
      throw new WriteQueryError(
        `setNavPrefs row-count mismatch: expected 1, got ${result.rows.length}`,
        "unexpected_row_count",
        { expected: 1, actual: result.rows.length },
      );
    }
    return rowToPrefs(result.rows[0]);
  } finally {
    client.release();
  }
}
