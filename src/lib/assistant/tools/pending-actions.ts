/**
 * pending-actions.ts — persistence + execution for Phase-3 action-tool
 * confirmation flow.
 *
 * Lifecycle:
 *   1. Action tool's dispatch returns needs_confirmation.
 *   2. Dispatcher calls savePendingAction(...) → row inserted with
 *      5-min expiry.
 *   3. Chat returns the "Say 'confirm' to proceed" prompt to the user.
 *   4. User's next turn matches a confirmation phrase
 *      ({yes, confirm, go ahead, do it, proceed, ok}).
 *   5. consumeMostRecentPendingAction() returns the row + marks it
 *      consumed; chat() invokes the tool's handler with the saved
 *      params; audit-log entry written; analytics fire.
 *   6. If the user cancels OR doesn't confirm within 5 min, the row
 *      lapses. cleanupExpiredPendingActions() (cron-friendly) sets
 *      consumed_via = 'expired'.
 */

import { safeQuery } from "@/lib/db";

export const CONFIRMATION_PHRASES = [
  "confirm",
  "yes",
  "yes please",
  "yep",
  "yeah",
  "go ahead",
  "proceed",
  "do it",
  "ok",
  "okay",
  "sure",
];

export const CANCELLATION_PHRASES = [
  "cancel",
  "no",
  "nope",
  "stop",
  "abort",
  "never mind",
  "nevermind",
];

export interface PendingActionRow {
  id: string;
  user_id: string;
  tool_name: string;
  params: Record<string, unknown>;
  description: string;
  created_at: string;
  expires_at: string;
}

/**
 * Detect whether a message is a confirmation or cancellation. Strict
 * full-string match (case-insensitive, punctuation-tolerant) so casual
 * sentences containing "yes" mid-thought ("yes, but also...") don't
 * trigger the execute path. The user has to mean it.
 */
/** Matches the column default in migration 135. */
const DEFAULT_PENDING_TTL_MINUTES = 5;

/**
 * How long an offer to SAVE something the person has just read stays open.
 *
 * Long enough to read a dozen steps back, think about whether the order is
 * right, and answer. Nothing here acts on anybody else's behalf.
 */
export const REVIEWABLE_PENDING_TTL_MINUTES = 60;

export type ConfirmIntent = "confirm" | "cancel" | "none";

export function detectConfirmationIntent(message: string): ConfirmIntent {
  /* Strip trailing punctuation with a linear scan rather than a
     `/[.!?,]+$/` regex — the anchored quantifier backtracks
     polynomially on inputs like "!!!!!!x" (ReDoS, CWE-1333). */
  const lowered = message.trim().toLowerCase();
  let end = lowered.length;
  while (end > 0 && ".!?,".includes(lowered[end - 1])) end--;
  const m = lowered.slice(0, end);
  if (CONFIRMATION_PHRASES.includes(m)) return "confirm";
  if (CANCELLATION_PHRASES.includes(m)) return "cancel";
  return "none";
}

/**
 * Persist a pending action. Returns the new row's id + description so
 * the dispatcher can compose the confirm prompt.
 *
 * Shadow-mode (no DATABASE_URL): returns a synthetic id so the chat
 * surface can still render the prompt; the eventual confirmation will
 * be a no-op since there's no row to consume. The dispatcher routes
 * "no row found" the same way it routes "expired."
 */
export async function savePendingAction(args: {
  userId: string;
  toolName: string;
  params: Record<string, unknown>;
  description: string;
  /**
   * How long the offer stays answerable, in minutes. Defaults to the column
   * default of five.
   *
   * FIVE MINUTES IS RIGHT FOR A SEND AND WRONG FOR A DECISION. The window was
   * set for actions that do something irreversible to somebody else, where a
   * "yes" arriving out of the blue half an hour later is a genuine harm. It is
   * the wrong window for an offer whose whole point is that the person reads
   * something over first: a plan of their own working day runs to a dozen
   * steps, and deciding whether it is right is not a five-minute job.
   *
   * The cost of the two mistakes is not symmetric either. A stale yes to a
   * saved routine leaves a command they can delete. A window that closes while
   * somebody is still reading tells them the assistant has lost the thread of
   * a conversation they are in the middle of, which is the thing that makes
   * people stop trusting it.
   */
  ttlMinutes?: number;
}): Promise<{ id: string; description: string; saved: boolean }> {
  if (!process.env.DATABASE_URL) {
    return {
      id: `shadow-${Date.now()}`,
      description: args.description,
      /* NOT SAVED, AND SAID SO. There is no row, so the confirmation that
         follows will find nothing. A caller that offers anyway is making a
         promise this returned value already knows is broken. */
      saved: false,
    };
  }
  try {
    const r = await safeQuery<{ id: string }>(
      `INSERT INTO instinct_pending_actions
         (user_id, tool_name, params, description, expires_at)
       VALUES ($1, $2, $3::jsonb, $4,
               now() + make_interval(mins => $5::int))
       RETURNING id`,
      [
        args.userId,
        args.toolName,
        JSON.stringify(args.params),
        args.description,
        args.ttlMinutes ?? DEFAULT_PENDING_TTL_MINUTES,
      ],
    );
    const id = r.rows[0]?.id;
    if (!id) return { id: `fallback-${Date.now()}`, description: args.description, saved: false };
    return { id, description: args.description, saved: true };
  } catch {
    return {
      id: `error-${Date.now()}`,
      description: args.description,
      saved: false,
    };
  }
}

/**
 * Atomically claim the user's most recent live pending action — the
 * UPDATE...RETURNING locks the row so two concurrent confirms can't
 * execute the same action twice.
 *
 * Returns the row when one was successfully claimed. Returns null when
 * the user has no live pending action (none ever saved, all expired,
 * or already consumed).
 */
export async function consumeMostRecentPendingAction(
  userId: string,
  via: "confirm" | "cancel",
): Promise<PendingActionRow | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const r = await safeQuery<PendingActionRow>(
      `UPDATE instinct_pending_actions
          SET consumed_at = now(),
              consumed_by = $1,
              consumed_via = $2
        WHERE id = (
          SELECT id FROM instinct_pending_actions
           WHERE user_id = $1
             AND consumed_at IS NULL
             AND expires_at > now()
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, user_id, tool_name, params, description,
                  created_at::text, expires_at::text`,
      [userId, via],
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Mark every expired pending action as consumed_via = 'expired'. Safe
 * to run on a cron (every minute is fine — partial index keeps it
 * cheap). Returns the count of rows lapsed for analytics.
 */
export async function cleanupExpiredPendingActions(): Promise<number> {
  if (!process.env.DATABASE_URL) return 0;
  try {
    const r = await safeQuery<{ count: string }>(
      `WITH lapsed AS (
        UPDATE instinct_pending_actions
           SET consumed_at = now(),
               consumed_via = 'expired'
         WHERE consumed_at IS NULL
           AND expires_at <= now()
        RETURNING id
      )
      SELECT count(*)::text AS count FROM lapsed`,
    );
    return parseInt(r.rows[0]?.count ?? "0", 10);
  } catch {
    return 0;
  }
}
