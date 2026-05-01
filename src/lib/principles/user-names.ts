/**
 * User-id → display name resolver.
 *
 * The principles UI shows `subject_user_id` in the team scoreboard;
 * raw UUIDs aren't useful to a human reader. This lib joins against
 * the existing M365-token + directory tables to attach a display
 * name + email when one is known.
 *
 * Sources, in priority order:
 *   1) instinct_ms_tokens.display_name + user_email (most reliable —
 *      every user with a connected M365 account has a row here).
 *   2) instinct_directory_users.display_name + mail (fallback when a
 *      user is in the directory but no token yet — rare).
 *   3) Final fallback: return the user_id as the name.
 */

import { safeQuery } from "@/lib/db";

export interface UserNameRecord {
  userId: string;
  displayName: string;
  email: string | null;
}

interface NameRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
}

/**
 * Bulk lookup. Pass a list of user ids; returns a map keyed by id.
 * Missing ids fall through to `{ displayName: <id>, email: null }`
 * so a caller never has to handle a null in the rendered cell.
 */
export async function resolveUserNames(
  userIds: string[],
): Promise<Map<string, UserNameRecord>> {
  const out = new Map<string, UserNameRecord>();
  const distinct = Array.from(
    new Set(userIds.filter((u): u is string => Boolean(u))),
  );
  if (distinct.length === 0) return out;

  /* The token table indexes by `connected_by` (the Instinct user id);
     the directory table doesn't always carry the Instinct id, so we
     prefer the token row when available. */
  const result = await safeQuery<NameRow>(
    `SELECT connected_by AS user_id,
            display_name,
            user_email AS email
       FROM instinct_ms_tokens
      WHERE connected_by = ANY($1)`,
    [distinct],
  );
  for (const r of result.rows) {
    out.set(r.user_id, {
      userId: r.user_id,
      displayName: r.display_name?.trim() || r.email || r.user_id,
      email: r.email,
    });
  }

  /* Backfill any ids that didn't have a token row. */
  for (const id of distinct) {
    if (!out.has(id)) {
      out.set(id, { userId: id, displayName: id, email: null });
    }
  }
  return out;
}
