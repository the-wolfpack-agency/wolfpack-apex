/**
 * automations / mailbox-cursors — per-base mailbox cursor reads + writes.
 *
 * Replaces the synthetic-string cursor key trick that previously
 * overloaded `instinct_automation_porsche_poll_state.user_id` with values
 * like "<userId>::<base>". The new normalized table is
 * `mailbox_poll_cursors` (migration 106), keyed by the composite
 * (automation_id, user_id, mailbox_base).
 *
 * Backward-compat: `getCursor` falls back to the legacy single-cursor
 * table for ONE release window when no row is present in
 * `mailbox_poll_cursors`. The first successful write through `setCursor`
 * promotes the row to the new table and subsequent reads short-circuit
 * to the new path. Tagged `// TODO(2026-Q3): remove legacy delta_link
 * fallback after 2026-06-01.` at every fallback site so the cleanup is
 * easy to find.
 *
 * mailbox_base contract: empty string '' represents the legacy default
 * mailbox (single-mailbox callers that previously stored a plain user_id
 * key). Non-empty values are the literal Graph base path WITHOUT the
 * leading slash quirk — passed in as-is by the poller (e.g. "/me",
 * "/users/alicia%40thewolfpack.agency"). Tests cover both shapes.
 */

import { query, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { AutomationId } from "./types";

export interface CursorKey {
  automationId: AutomationId;
  userId: string;
  /** Empty string '' = legacy default mailbox. */
  mailboxBase: string;
}

export interface CursorRecord {
  delta_link: string | null;
  /** ISO timestamp; null if the row has never been written. */
  last_polled_at: string | null;
}

/**
 * Read the cursor for (automationId, userId, mailboxBase).
 *
 * Preferred path: SELECT from `mailbox_poll_cursors` on the composite
 * key. When that row is absent, fall back to the legacy
 * `instinct_automation_porsche_poll_state` table for one release window.
 * In legacy fallback we synthesize the historical key shape that the
 * old code wrote: plain userId for the default mailbox, "<userId>::<base>"
 * for non-default. The fallback is read-only here; `setCursor` always
 * writes to the new table so the fallback decays naturally.
 *
 * Returns null when no cursor exists in either table.
 */
export async function getCursor(key: CursorKey): Promise<string | null> {
  const r = await query<{ delta_link: string | null }>(
    `SELECT delta_link
       FROM mailbox_poll_cursors
      WHERE automation_id = $1
        AND user_id       = $2
        AND mailbox_base  = $3`,
    [key.automationId, key.userId, key.mailboxBase],
  );
  if (r.rows.length > 0) {
    return r.rows[0].delta_link ?? null;
  }
  // TODO(2026-Q3): remove legacy delta_link fallback after 2026-06-01.
  // Until then, fall back to the synthetic-key shape on the legacy
  // single-cursor table so cursors written before migration 106 keep
  // resolving. Default mailbox = plain userId; non-default = userId::base.
  const legacyKey =
    key.mailboxBase === "" ? key.userId : `${key.userId}::${key.mailboxBase}`;
  const legacy = await query<{ delta_link: string | null }>(
    `SELECT delta_link
       FROM instinct_automation_porsche_poll_state
      WHERE automation_id = $1 AND user_id = $2`,
    [key.automationId, legacyKey],
  );
  return legacy.rows[0]?.delta_link ?? null;
}

/**
 * Write the cursor for (automationId, userId, mailboxBase). Idempotent —
 * uses INSERT ... ON CONFLICT to upsert. Emits the
 * `automations.cursor_advanced` analytics event so the learning loop
 * sees mailbox liveness over time.
 *
 * `cursorKind` is metadata for analytics only ("delta" | "search"). The
 * poller passes which Graph access mode produced the cursor so dashboards
 * can split stalled-mailbox detection by mode.
 *
 * `userRole` is forwarded into the analytics event. Best-effort — if the
 * caller can't supply one, pass "system".
 */
export async function setCursor(args: {
  key: CursorKey;
  deltaLink: string | null;
  cursorKind: "delta" | "search";
  userRole: string;
}): Promise<void> {
  /* Compute ms-since-last-poll BEFORE the write so the analytics event
     reflects the elapsed time at the start of THIS poll, not "0ms"
     (which we'd get from reading our own NOW()-dated row back). Null
     when the row doesn't exist yet — first cursor write for this base. */
  let msSinceLastPoll: number | null = null;
  try {
    const prev = await query<{ last_polled_at: string | null }>(
      `SELECT last_polled_at
         FROM mailbox_poll_cursors
        WHERE automation_id = $1
          AND user_id       = $2
          AND mailbox_base  = $3`,
      [args.key.automationId, args.key.userId, args.key.mailboxBase],
    );
    const ts = prev.rows[0]?.last_polled_at ?? null;
    if (ts) {
      const t = new Date(ts).getTime();
      if (Number.isFinite(t)) msSinceLastPoll = Date.now() - t;
    }
  } catch {
    /* analytics enrichment is best-effort; never block the write */
  }

  await writeQuery(
    `INSERT INTO mailbox_poll_cursors
       (automation_id, user_id, mailbox_base, delta_link, last_polled_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (automation_id, user_id, mailbox_base) DO UPDATE SET
       delta_link     = EXCLUDED.delta_link,
       last_polled_at = NOW(),
       updated_at     = NOW()
     RETURNING id`,
    [args.key.automationId, args.key.userId, args.key.mailboxBase, args.deltaLink],
    { expectRows: 1 },
  );

  try {
    trackEvent("automations.cursor_advanced", args.key.userId, args.userRole, {
      automation_id: args.key.automationId,
      mailbox_base: args.key.mailboxBase,
      cursor_kind: args.cursorKind,
      /* trackEvent's metadata bag is `Record<string, string|number|boolean>`
         — no null. Use -1 as the "first cursor write for this base"
         sentinel; consumers reading this field can branch on `< 0`
         instead of NULL. Real elapsed times are always >= 0. */
      ms_since_last_poll: msSinceLastPoll ?? -1,
    });
  } catch {
    /* analytics is best-effort; never block the cron tick */
  }
}
