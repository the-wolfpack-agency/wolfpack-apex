/**
 * Repository for SharePoint connector sources + ingest jobs.
 *
 * Pure DB layer. No Graph calls, no business logic. Caller injects the
 * query runner so tests can use a fake.
 */

import type { QueryResult } from "pg";
import { query as defaultQuery } from "@/lib/db";
import type {
  SharepointSource,
  IngestJob,
  IngestJobStatus,
} from "./types";

export interface QueryRunner {
  <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

interface SourceRow extends Record<string, unknown> {
  id: string;
  estate?: string | null;
  workspace_id: string;
  name: string;
  site_url: string;
  site_id: string;
  drive_id: string;
  folder_path: string;
  created_by: string;
  created_at: string;
  last_synced_at: string | null;
  is_active: boolean;
  audience_roles?: string[] | null;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  source_id: string;
  triggered_by: string;
  started_at: string;
  ended_at: string | null;
  status: IngestJobStatus;
  file_count: number;
  success_count: number;
  fail_count: number;
  bytes_ingested: string | number;
  error: string | null;
}

function rowToSource(r: SourceRow): SharepointSource {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    siteUrl: r.site_url,
    siteId: r.site_id,
    driveId: r.drive_id,
    folderPath: r.folder_path,
    createdBy: r.created_by,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
    isActive: r.is_active,
    /* Fails to 'wolfpack', never null, so an unclassified source stays out of
       a client's figures rather than leaking into them. */
    estate: (r.estate as string | null) ?? "wolfpack",
    /* FAILS CLOSED. A row read before migration 239, or one whose column is
       somehow null, is admin-only rather than everyone: the default has to be
       the safe answer, because the unsafe one is invisible until a dealer is
       quoted an HR file. */
    audienceRoles:
      Array.isArray(r.audience_roles) && r.audience_roles.length > 0
        ? r.audience_roles
        : ["admin"],
  };
}

function rowToJob(r: JobRow): IngestJob {
  return {
    id: r.id,
    sourceId: r.source_id,
    triggeredBy: r.triggered_by,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    fileCount: r.file_count,
    successCount: r.success_count,
    failCount: r.fail_count,
    bytesIngested: typeof r.bytes_ingested === "string" ? Number(r.bytes_ingested) : r.bytes_ingested,
    error: r.error,
  };
}

export interface SharepointRepo {
  insertSource(input: {
    workspaceId: string;
    name: string;
    siteUrl: string;
    siteId: string;
    driveId: string;
    folderPath: string;
    createdBy: string;
  }): Promise<SharepointSource>;
  listSources(workspaceId: string): Promise<SharepointSource[]>;
  getSource(id: string, workspaceId: string): Promise<SharepointSource | null>;
  deactivateSource(id: string, workspaceId: string): Promise<boolean>;
  touchLastSynced(id: string): Promise<void>;
  startJob(sourceId: string, triggeredBy: string): Promise<IngestJob>;
  finishJob(
    id: string,
    update: {
      status: IngestJobStatus;
      fileCount: number;
      successCount: number;
      failCount: number;
      bytesIngested: number;
      error?: string | null;
    },
  ): Promise<void>;
  listJobsForSource(sourceId: string, limit?: number): Promise<IngestJob[]>;
  /** Sweep stuck jobs whose status is still 'running' more than
   *  `staleMinutes` minutes after they started. Marks them as
   *  'failed' with a synthesized error message. Returns the count of
   *  rows updated. Called from the GET /sources/[id] route so the UI
   *  sees consistent state without a separate cron job. */
  reconcileStuckJobs(staleMinutes?: number): Promise<number>;
}

export function createRepo(qr: QueryRunner = defaultQuery): SharepointRepo {
  return {
    async insertSource(input) {
      const res = await qr<SourceRow>(
        `INSERT INTO instinct_sharepoint_sources
          (workspace_id, name, site_url, site_id, drive_id, folder_path, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          input.workspaceId,
          input.name,
          input.siteUrl,
          input.siteId,
          input.driveId,
          input.folderPath,
          input.createdBy,
        ],
      );
      return rowToSource(res.rows[0]);
    },

    async listSources(workspaceId) {
      const res = await qr<SourceRow>(
        `SELECT * FROM instinct_sharepoint_sources
          WHERE workspace_id = $1 AND is_active = TRUE
          ORDER BY created_at DESC`,
        [workspaceId],
      );
      return res.rows.map(rowToSource);
    },

    async getSource(id, workspaceId) {
      const res = await qr<SourceRow>(
        `SELECT * FROM instinct_sharepoint_sources
          WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      );
      return res.rows[0] ? rowToSource(res.rows[0]) : null;
    },

    async deactivateSource(id, workspaceId) {
      const res = await qr(
        `UPDATE instinct_sharepoint_sources
            SET is_active = FALSE
          WHERE id = $1 AND workspace_id = $2 AND is_active = TRUE`,
        [id, workspaceId],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async touchLastSynced(id) {
      await qr(
        `UPDATE instinct_sharepoint_sources SET last_synced_at = NOW() WHERE id = $1`,
        [id],
      );
    },

    async startJob(sourceId, triggeredBy) {
      const res = await qr<JobRow>(
        `INSERT INTO instinct_sharepoint_ingest_jobs (source_id, triggered_by)
         VALUES ($1,$2) RETURNING *`,
        [sourceId, triggeredBy],
      );
      return rowToJob(res.rows[0]);
    },

    async finishJob(id, update) {
      await qr(
        `UPDATE instinct_sharepoint_ingest_jobs
            SET ended_at = NOW(),
                status = $2,
                file_count = $3,
                success_count = $4,
                fail_count = $5,
                bytes_ingested = $6,
                error = $7
          WHERE id = $1`,
        [
          id,
          update.status,
          update.fileCount,
          update.successCount,
          update.failCount,
          update.bytesIngested,
          update.error ?? null,
        ],
      );
    },

    async listJobsForSource(sourceId, limit = 20) {
      const res = await qr<JobRow>(
        `SELECT * FROM instinct_sharepoint_ingest_jobs
          WHERE source_id = $1
          ORDER BY started_at DESC
          LIMIT $2`,
        [sourceId, limit],
      );
      return res.rows.map(rowToJob);
    },

    async reconcileStuckJobs(staleMinutes = 6) {
      const res = await qr(
        `UPDATE instinct_sharepoint_ingest_jobs
            SET status = 'failed',
                ended_at = NOW(),
                error = COALESCE(error, 'reconciler: job exceeded ' || $1::text || ' min running without completion')
          WHERE status = 'running'
            AND started_at < NOW() - (INTERVAL '1 minute' * $1)`,
        [staleMinutes],
      );
      return res.rowCount ?? 0;
    },
  };
}
