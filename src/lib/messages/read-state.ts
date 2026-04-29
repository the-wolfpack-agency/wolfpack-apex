/**
 * Per-user-per-chat last-read tracking for the /messages page.
 *
 * Drives the bold + dot unread visualization on chats / channels /
 * teams. The Microsoft Graph delegated `/me/chats` endpoint does NOT
 * expose a per-chat unreadCount on Chat.Read; we synthesize the same
 * UX by storing each (user, chat_id) cursor here and comparing it
 * with `lastMessage.createdDateTime` on render.
 *
 * Schema (migration 107):
 *   CREATE TABLE chat_read_state (
 *     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id TEXT NOT NULL,
 *     chat_id TEXT NOT NULL,
 *     last_read_at TIMESTAMPTZ NOT NULL,
 *     updated_at TIMESTAMPTZ DEFAULT now(),
 *     UNIQUE (user_id, chat_id)
 *   );
 *
 * Same table backs the channel and team surfaces — `chat_id` carries
 * whichever Graph object id the surface owns. Routes pass an opaque
 * `kind` ∈ "chat" | "channel" | "team" to analytics so the dashboard
 * can split adoption per surface; the storage is kind-agnostic.
 */

import { writeQuery, safeQuery, WriteQueryError } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type ReadStateKind = "chat" | "channel" | "team";

export interface ReadStateRow {
  user_id: string;
  chat_id: string;
  /**
   * Postgres `timestamptz` lands here as either a Date (live driver)
   * or an ISO string (some shadow / mock paths). The helpers normalize
   * both to ISO strings before returning to callers.
   */
  last_read_at: string | Date;
}

/**
 * Load every read-state cursor the user has. Returns a Map keyed by
 * `chat_id` → `last_read_at` (ISO 8601). The chat list compares each
 * row's `lastMessage.createdDateTime` against this value.
 *
 * Empty Map for new users (no rows yet) and shadow-mode (no
 * DATABASE_URL). Never throws — read-state is a UI driver, not a
 * blocker.
 */
export async function getReadState(
  userId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!userId) return out;
  const result = await safeQuery<ReadStateRow>(
    `SELECT user_id, chat_id, last_read_at
       FROM chat_read_state
      WHERE user_id = $1`,
    [userId],
  );
  for (const row of result.rows) {
    if (typeof row.chat_id === "string" && row.last_read_at != null) {
      const iso = toIso(row.last_read_at);
      if (iso) out.set(row.chat_id, iso);
    }
  }
  return out;
}

/** Normalize a Postgres timestamptz value (Date | string) to ISO 8601. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Upsert a single (user, chat_id) cursor forward. Idempotent — if
 * `last_read_at` is older than the existing row's value, we keep the
 * existing value (cursors only advance forward). Emits
 * `messages.read_state_advanced` analytics on every successful write.
 *
 * Returns the value actually persisted (may be the existing newer
 * value if the caller passed a stale timestamp).
 */
export async function setReadState(
  userId: string,
  chatId: string,
  lastReadAt: string,
  opts: {
    kind?: ReadStateKind;
    userRole?: string;
  } = {},
): Promise<string> {
  if (!userId) {
    throw new WriteQueryError("setReadState: userId is required", "db_error");
  }
  if (!chatId) {
    throw new WriteQueryError("setReadState: chatId is required", "db_error");
  }
  // Validate the ISO timestamp up front — a bad string would round-trip
  // through Postgres as a parser error and we'd lose the diagnostic.
  const parsed = Date.parse(lastReadAt);
  if (Number.isNaN(parsed)) {
    throw new WriteQueryError(
      `setReadState: lastReadAt must be ISO 8601 (got "${lastReadAt}")`,
      "db_error",
    );
  }
  const isoIn = new Date(parsed).toISOString();

  // Forward-only upsert: if the existing row's `last_read_at` is newer
  // than the incoming value, keep the existing value. The
  // `GREATEST(...)` guards against out-of-order writes (e.g. the user
  // re-opens a chat in a slow tab while a fresh open already advanced
  // the cursor on a faster tab).
  const result = await writeQuery<ReadStateRow>(
    `INSERT INTO chat_read_state (user_id, chat_id, last_read_at, updated_at)
     VALUES ($1, $2, $3::timestamptz, now())
     ON CONFLICT (user_id, chat_id)
     DO UPDATE SET
       last_read_at = GREATEST(chat_read_state.last_read_at, EXCLUDED.last_read_at),
       updated_at = now()
     RETURNING user_id, chat_id, last_read_at`,
    [userId, chatId, isoIn],
    { expectRows: 1 },
  );

  const persistedRaw = result.rows[0]?.last_read_at;
  const persisted = toIso(persistedRaw) ?? isoIn;

  trackEvent("messages.read_state_advanced", userId, opts.userRole ?? "unknown", {
    chat_id: chatId,
    kind: opts.kind ?? "chat",
  });

  return persisted;
}
