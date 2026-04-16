/**
 * File / Collaboration signals derived from the OneDrive files cache + audit log.
 *
 * Surfaces two helpers for the assistant + briefing + learning loop:
 *   - getMostAccessedFiles(userId, windowDays): files the user views/downloads
 *     the most frequently in the window (approximated by synced_at + audit
 *     events `files.share_created` / `files.uploaded`).
 *   - getCollaborationGraph(userId): people the user shares files with,
 *     derived from `files.share_created` audit entries.
 *
 * These are read-only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { safeQuery } from "@/lib/db";

export interface FileAccessSignal {
  msDriveItemId: string;
  name: string;
  webUrl: string | null;
  touches: number;
  lastTouchedAt: string;
}

export interface CollaborationEdge {
  /** Raw resource id that was shared — an `ms_drive_item` id. */
  resourceId: string;
  shareCount: number;
  firstAt: string;
  lastAt: string;
}

export async function getMostAccessedFiles(
  userId: string,
  windowDays = 30,
  limit = 10,
): Promise<FileAccessSignal[]> {
  const cappedWindow = Math.max(1, Math.min(365, windowDays));
  const cappedLimit = Math.max(1, Math.min(50, limit));

  // Approximate "accessed" as "row was synced/refreshed within the window"
  // combined with audit event counts. We don't have per-access hits yet;
  // this is a useful stand-in that will stay correct once we add one.
  const { rows } = await safeQuery<any>(
    `WITH audit_touches AS (
       SELECT resource_id, COUNT(*)::int AS c, MAX(ts) AS last_ts
       FROM instinct_audit_log
       WHERE resource_type = 'ms_drive_item'
         AND actor_user_id = $1
         AND ts >= NOW() - INTERVAL '1 day' * $2
       GROUP BY resource_id
     )
     SELECT m.ms_drive_item_id,
            m.name,
            m.web_url,
            COALESCE(a.c, 0) + 1 AS touches,
            GREATEST(COALESCE(a.last_ts, m.synced_at), m.synced_at) AS last_touched_at
     FROM instinct_ms_files_metadata m
     LEFT JOIN audit_touches a ON a.resource_id = m.ms_drive_item_id
     WHERE m.user_id = $1
       AND m.synced_at >= NOW() - INTERVAL '1 day' * $2
     ORDER BY touches DESC, last_touched_at DESC
     LIMIT $3`,
    [userId, cappedWindow, cappedLimit],
  );

  return rows.map((r) => ({
    msDriveItemId: r.ms_drive_item_id,
    name: r.name,
    webUrl: r.web_url,
    touches: Number(r.touches),
    lastTouchedAt: new Date(r.last_touched_at).toISOString(),
  }));
}

/**
 * Return the items this user has shared, sorted by share frequency.
 * The "collaborator" dimension (who the link goes to) is not captured
 * by Graph's createLink API directly — share links are broadcast. So
 * this returns shared-items rather than per-person edges. If Stream A's
 * `instinct_sent_mail` + recipients view becomes available, callers can
 * intersect on resource-id references to derive per-person edges.
 */
export async function getCollaborationGraph(
  userId: string,
  windowDays = 90,
  limit = 25,
): Promise<CollaborationEdge[]> {
  const cappedWindow = Math.max(1, Math.min(365, windowDays));
  const cappedLimit = Math.max(1, Math.min(100, limit));

  const { rows } = await safeQuery<any>(
    `SELECT resource_id,
            COUNT(*)::int AS share_count,
            MIN(ts) AS first_at,
            MAX(ts) AS last_at
     FROM instinct_audit_log
     WHERE resource_type = 'ms_drive_item'
       AND action = 'files.share_created'
       AND actor_user_id = $1
       AND ts >= NOW() - INTERVAL '1 day' * $2
     GROUP BY resource_id
     ORDER BY share_count DESC, last_at DESC
     LIMIT $3`,
    [userId, cappedWindow, cappedLimit],
  );

  return rows.map((r) => ({
    resourceId: r.resource_id,
    shareCount: Number(r.share_count),
    firstAt: new Date(r.first_at).toISOString(),
    lastAt: new Date(r.last_at).toISOString(),
  }));
}
