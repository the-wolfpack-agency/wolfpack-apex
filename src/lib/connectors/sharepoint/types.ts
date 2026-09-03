/**
 * Type contracts for the SharePoint connector. Mirrors migration 139.
 */

export interface SharepointSource {
  id: string;
  workspaceId: string;
  /**
   * Roles that may be quoted documents from this library.
   *
   * Admin-only by default at the database level, because widening is a
   * decision somebody makes and narrowing must never be something they forget.
   */
  audienceRoles: string[];
  name: string;
  siteUrl: string;
  siteId: string;
  driveId: string;
  folderPath: string;
  createdBy: string;
  createdAt: string;
  lastSyncedAt: string | null;
  isActive: boolean;
  /**
   * Whose material this library holds, carried onto every document synced from
   * it. Without this a synced document has a null estate and drops out of every
   * client-facing figure that filters by estate: a client's own SharePoint,
   * indexed, would not count as theirs. Defaults to 'wolfpack' when a row
   * predates the column, which keeps unclassified content OUT of a client's
   * numbers rather than silently into them.
   */
  estate: string;
}

export type IngestJobStatus = "running" | "succeeded" | "failed" | "partial";

export interface IngestJob {
  id: string;
  sourceId: string;
  triggeredBy: string;
  startedAt: string;
  endedAt: string | null;
  status: IngestJobStatus;
  fileCount: number;
  successCount: number;
  failCount: number;
  bytesIngested: number;
  error: string | null;
}

/** Input from the admin UI when adding a new source. */
export interface AddSourceInput {
  workspaceId: string;
  name: string;
  siteUrl: string;
  createdBy: string;
}
