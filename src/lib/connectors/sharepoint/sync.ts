/**
 * Sync orchestrator for a SharePoint connector source.
 *
 * Walks the source's drive folder via Microsoft Graph, downloads each
 * file, and hands it to the Central Brain ingest pipeline. Records a
 * full audit row in instinct_sharepoint_ingest_jobs and fires analytics
 * events so the learning loop sees every run.
 *
 * Contract guarantees (per CLAUDE.md "data and learning integration"):
 *   - A job row is created BEFORE the first file is touched. If the
 *     process crashes mid-run, the row stays with status='running' and
 *     a reconciler can mark it failed later.
 *   - Every successfully-ingested file produces a brain_documents row
 *     (the brain ingest module owns that contract).
 *   - File-level failures don't abort the run. They increment fail_count
 *     and the run ends with status='partial' if any failed.
 *   - Bytes ingested + file counts roll up into the job row so the
 *     analytics dashboard can show throughput per source over time.
 *
 * No raw fetches: all Graph calls go through graphFetch.
 */

import { graphFetch, getValidToken } from "@/lib/microsoft-graph";
import { ingest as brainIngest } from "@/lib/brain/ingest";
import { trackEvent } from "@/lib/analytics";
import { createRepo, type SharepointRepo } from "./repo";
import type { IngestJobStatus, SharepointSource } from "./types";

export interface SyncResult {
  jobId: string;
  status: IngestJobStatus;
  fileCount: number;
  successCount: number;
  failCount: number;
  bytesIngested: number;
  error: string | null;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string };
}

interface DriveChildrenPage {
  value: DriveItem[];
  "@odata.nextLink"?: string;
}

/** List EVERY item under a drive folder, recursing into subfolders.
 *  Returns leaf files only. Pagination via @odata.nextLink. */
async function walkFolder(
  userId: string,
  driveId: string,
  folderPath: string,
): Promise<DriveItem[]> {
  const token = await getValidToken(userId);
  if (!token) throw new Error("no_token");
  const out: DriveItem[] = [];
  const rootPath = folderPath.replace(/^\/+|\/+$/g, "");
  const initial = rootPath
    ? `drives/${encodeURIComponent(driveId)}/root:/${encodeURI(rootPath)}:/children?$top=200`
    : `drives/${encodeURIComponent(driveId)}/root/children?$top=200`;
  const queue: string[] = [initial];
  while (queue.length > 0) {
    const endpoint = queue.shift()!;
    const page = await graphFetch<DriveChildrenPage>(endpoint, token.accessToken, userId);
    if (!page || !Array.isArray(page.value)) continue;
    for (const item of page.value) {
      if (item.folder) {
        queue.push(
          `drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/children?$top=200`,
        );
      } else if (item.file) {
        out.push(item);
      }
    }
    if (page["@odata.nextLink"]) {
      queue.push(page["@odata.nextLink"].replace(/^https:\/\/graph\.microsoft\.com\/v1\.0\//, ""));
    }
  }
  return out;
}

/** Download a file's bytes from a drive item. */
async function downloadDriveItem(
  userId: string,
  driveId: string,
  itemId: string,
): Promise<Buffer> {
  const token = await getValidToken(userId);
  if (!token) throw new Error("no_token");
  const url = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`download_failed_${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export interface SyncOpts {
  /** Override the brain-ingest function (for tests). */
  ingestFn?: typeof brainIngest;
  /** Override the file-walker (for tests). */
  walkFn?: typeof walkFolder;
  /** Override the file downloader (for tests). */
  downloadFn?: typeof downloadDriveItem;
  /** Override repo (for tests). */
  repo?: SharepointRepo;
  /** Use an existing job row instead of creating a new one. The POST
   *  route uses this so it can return the jobId to the UI before the
   *  background sync runs. */
  existingJobId?: string;
}

/** Run one sync of the given source. Never throws — failures surface
 *  through the returned SyncResult and the job row. */
export async function syncSource(
  source: SharepointSource,
  triggeredBy: string,
  triggeredByRole: string,
  opts: SyncOpts = {},
): Promise<SyncResult> {
  const repo = opts.repo ?? createRepo();
  const ingestFn = opts.ingestFn ?? brainIngest;
  const walkFn = opts.walkFn ?? walkFolder;
  const downloadFn = opts.downloadFn ?? downloadDriveItem;

  /* Caller can pre-create the job row (POST route does this so it can
   * return the jobId in the 202 response). When provided we wrap it
   * minimally — we only need its id for finishJob(). */
  const job = opts.existingJobId
    ? { id: opts.existingJobId }
    : await repo.startJob(source.id, triggeredBy);

  trackEvent("connectors.sharepoint.sync_started", triggeredBy, triggeredByRole, {
    source_id: source.id,
    workspace_id: source.workspaceId,
    job_id: job.id,
  });

  let fileCount = 0;
  let successCount = 0;
  let failCount = 0;
  let bytesIngested = 0;
  let topLevelError: string | null = null;

  try {
    const files = await walkFn(triggeredBy, source.driveId, source.folderPath);
    fileCount = files.length;

    for (const f of files) {
      try {
        const buf = await downloadFn(triggeredBy, source.driveId, f.id);
        await ingestFn({
          filename: f.name,
          contentType: f.file?.mimeType ?? "application/octet-stream",
          buffer: buf,
          uploadedBy: triggeredBy,
          uploaderRole: triggeredByRole,
          tags: ["sharepoint", `sp-source:${source.id}`, `workspace:${source.workspaceId}`],
        });
        successCount++;
        bytesIngested += buf.length;
      } catch (err) {
        failCount++;
        trackEvent("connectors.sharepoint.file_ingest_failed", triggeredBy, triggeredByRole, {
          source_id: source.id,
          job_id: job.id,
          file_name: f.name,
          error: (err as Error).message.slice(0, 200),
        });
      }
    }
  } catch (err) {
    topLevelError = (err as Error).message;
  }

  const status: IngestJobStatus =
    topLevelError ? "failed" :
    failCount > 0 && successCount > 0 ? "partial" :
    failCount > 0 ? "failed" :
    "succeeded";

  await repo.finishJob(job.id, {
    status,
    fileCount,
    successCount,
    failCount,
    bytesIngested,
    error: topLevelError,
  });
  if (status !== "failed") {
    await repo.touchLastSynced(source.id);
  }

  trackEvent("connectors.sharepoint.sync_finished", triggeredBy, triggeredByRole, {
    source_id: source.id,
    job_id: job.id,
    status,
    file_count: fileCount,
    success_count: successCount,
    fail_count: failCount,
    bytes_ingested: bytesIngested,
  });

  return {
    jobId: job.id,
    status,
    fileCount,
    successCount,
    failCount,
    bytesIngested,
    error: topLevelError,
  };
}

export { walkFolder as __walkFolderForTests, downloadDriveItem as __downloadForTests };
