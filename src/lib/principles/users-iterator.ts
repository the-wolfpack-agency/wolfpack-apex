/**
 * Team-iterator — lists Instinct users with a usable Microsoft 365
 * connection, for the per-user fan-out evaluator.
 *
 * Source: `instinct_ms_tokens.connected_by` is the Instinct user id
 * whose OAuth grant is stored. We treat any token whose refresh path
 * has not been revoked as "connected" — `getValidToken()` will refresh
 * automatically when the cron evaluator calls it.
 *
 * Shadow-mode (no DATABASE_URL) returns []. Production reads list
 * users in stable order so the cron's per-user iteration is
 * deterministic.
 */

import { safeQuery } from "@/lib/db";

export interface ConnectedUser {
  userId: string;
  email: string;
  displayName: string | null;
  connectedAt: string;
}

interface ConnectedUserRow {
  connected_by: string;
  user_email: string;
  display_name: string | null;
  connected_at: string;
}

export async function listConnectedM365Users(): Promise<ConnectedUser[]> {
  const result = await safeQuery<ConnectedUserRow>(
    `SELECT DISTINCT ON (connected_by)
            connected_by, user_email, display_name, connected_at
       FROM instinct_ms_tokens
      ORDER BY connected_by, connected_at DESC`,
    [],
  );
  return result.rows.map((r) => ({
    userId: r.connected_by,
    email: r.user_email,
    displayName: r.display_name,
    connectedAt: r.connected_at,
  }));
}
