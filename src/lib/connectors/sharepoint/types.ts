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
