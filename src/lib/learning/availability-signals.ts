/**
 * Availability signals — aggregate cached OOO states.
 *
 * Caveat: OOO is reliably known only for users who personally refreshed
 * their mailbox settings via POST /api/mailbox/me/refresh-ooo. For
 * everyone else, we return whatever the cache holds (may be empty). The
 * returned `reliable` flag surfaces that distinction so the Assistant can
 * phrase answers honestly.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { safeQuery } from "@/lib/db";

export interface TeamAvailability {
  userId: string;
  msUserId: string | null;
  isOnOOO: boolean;
  scope: string;
  startAt: string | null;
  endAt: string | null;
  syncedAt: string;
}

export interface AvailabilitySummary {
  windowHours: number;
  evaluatedAt: string;
  known: TeamAvailability[];
  currentlyOut: TeamAvailability[];
  startingSoon: TeamAvailability[]; // OOO starts within windowHours
  reliable: boolean; // true iff at least one row exists
}

/**
 * Aggregate OOO state across all cached users. `windowHours` is the
 * forward-looking window for `startingSoon` — e.g. windowHours=48 returns
 * anyone whose OOO starts within the next 2 days.
 */
export async function getTeamAvailability(windowHours = 24): Promise<AvailabilitySummary> {
  const now = Date.now();
  const evaluatedAt = new Date(now).toISOString();

  const { rows } = await safeQuery<any>(
    `SELECT user_id, ms_user_id, is_enabled, scope, start_at, end_at, synced_at
       FROM instinct_mailbox_ooo_state`,
  );

  const known: TeamAvailability[] = rows.map((r) => ({
    userId: r.user_id,
    msUserId: r.ms_user_id ?? null,
    isOnOOO: Boolean(r.is_enabled),
    scope: r.scope ?? "none",
    startAt: r.start_at ? new Date(r.start_at).toISOString() : null,
    endAt: r.end_at ? new Date(r.end_at).toISOString() : null,
    syncedAt: new Date(r.synced_at).toISOString(),
  }));

  const currentlyOut: TeamAvailability[] = [];
  const startingSoon: TeamAvailability[] = [];

  const windowMs = Math.max(0, windowHours) * 60 * 60 * 1000;

  for (const row of known) {
    if (!row.isOnOOO) continue;
    const start = row.startAt ? Date.parse(row.startAt) : Number.NEGATIVE_INFINITY;
    const end = row.endAt ? Date.parse(row.endAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end) {
      currentlyOut.push(row);
    } else if (Number.isFinite(start) && start > now && start - now <= windowMs) {
      startingSoon.push(row);
    } else if (!row.startAt && !row.endAt) {
      // alwaysEnabled
      currentlyOut.push(row);
    }
  }

  return {
    windowHours,
    evaluatedAt,
    known,
    currentlyOut,
    startingSoon,
    reliable: known.length > 0,
  };
}
