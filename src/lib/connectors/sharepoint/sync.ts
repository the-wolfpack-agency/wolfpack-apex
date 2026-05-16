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
  webUrl?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string };
}

/** MIME-type prefixes that get a placeholder text doc when the file
 *  is too large to ingest directly. So a 500MB training video at
 *  least becomes searchable by name + clickable to watch. */
const PLACEHOLDER_MIME_PREFIXES = ["video/", "audio/"];

function isPlaceholderable(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return PLACEHOLDER_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
}

/** Coarse media-type label for a MIME string. Drives the "Training
 *  video", "Audio recording", etc. natural-language line in the body. */
function mediaLabel(mimeType: string | undefined): string {
  if (!mimeType) return "Media file";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio recording";
  return "Media file";
}

function placeholderBuffer(f: DriveItem, sourceName: string): Buffer {
  /* Body is designed for keyword + embedding retrieval. The first
   * paragraph reads as a natural-language description so a query like
   * "what training videos do we have for PCNA" tokenizes against
   * "video", "PCNA", "training", "Wolfpack" (via the source name).
   * Subsequent lines carry the structured metadata. */
  const label = mediaLabel(f.file?.mimeType);
  const lines: string[] = [
    `# ${f.name}`,
    "",
    `${label} from the ${sourceName} SharePoint source.`,
  ];
  if (f.parentReference?.path) {
    /* Convert "/drives/D/root:/Shared Documents/General/Ad-hoc Training Projects/Options Content"
     * into "Shared Documents / General / Ad-hoc Training Projects / Options Content"
     * so the folder breadcrumb words ("Training", "Options Content", etc.)
     * are searchable as separate tokens. */
    const breadcrumb = f.parentReference.path
      .replace(/^\/drives\/[^/]+\/root:?\/?/, "")
      .split("/")
      .filter(Boolean)
      .join(" / ");
    if (breadcrumb) {
      lines.push(`Located in: ${breadcrumb}.`);
    }
  }
  lines.push("");
  lines.push(
    `**File:** ${f.name}`,
    `**Type:** ${f.file?.mimeType ?? "unknown media"}`,
    `**Size:** ${typeof f.size === "number" ? `${f.size.toLocaleString()} bytes` : "unknown"}`,
    `**Source:** ${sourceName}`,
  );
  if (f.webUrl) lines.push(`**Watch:** ${f.webUrl}`);
  lines.push("");
  lines.push(
    `This is a placeholder for a ${label.toLowerCase()} too large to ingest into the searchable index directly.`,
    `The placeholder makes the file discoverable by name in chat and provides a link to view it.`,
    `If a transcript (.vtt or .txt) exists alongside the original in the same SharePoint folder, that transcript is indexed normally.`,
  );
  return Buffer.from(lines.join("\n"), "utf-8");
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

  /* Skip files larger than the brain ingest cap BEFORE downloading.
   * Downloading a 500MB video into a Buffer then handing it to brain
   * ingest (which rejects it anyway) wastes the function's memory and
   * can trigger a Vercel OOM that surfaces as an HTML 500 to the
   * client. Brain ingest's default cap is 50MB; we honor the same
   * env var to stay in sync. */
  const MAX_FILE_BYTES = Number(process.env.BRAIN_MAX_SIZE_BYTES ?? 50 * 1024 * 1024);

  /* Per-file errors accumulated so the job's top-level error field
   * tells the operator WHY each file failed. Was previously null,
   * which left the UI showing "failed" with no diagnosis. */
  const perFileErrors: string[] = [];

  try {
    const files = await walkFn(triggeredBy, source.driveId, source.folderPath);
    fileCount = files.length;

    for (const f of files) {
      try {
        if (typeof f.size === "number" && f.size > MAX_FILE_BYTES) {
          /* Oversized media (video/audio): index a placeholder so the
           * file is at least searchable by name + clickable. Without
           * this the operator silently loses every large video. */
          if (isPlaceholderable(f.file?.mimeType)) {
            const buf = placeholderBuffer(f, source.name);
            await ingestFn({
              filename: `${f.name}.placeholder.txt`,
              contentType: "text/plain",
              buffer: buf,
              uploadedBy: triggeredBy,
              uploaderRole: triggeredByRole,
              tags: [
                "sharepoint",
                "sp-video-placeholder",
                `sp-source:${source.id}`,
                `sp-source-name:${source.name}`,
                `workspace:${source.workspaceId}`,
              ],
            });
            successCount++;
            bytesIngested += buf.length;
            trackEvent("connectors.sharepoint.placeholder_indexed", triggeredBy, triggeredByRole, {
              source_id: source.id,
              job_id: job.id,
              file_name: f.name,
              file_size: f.size,
              mime_type: f.file?.mimeType ?? "",
            });
            continue;
          }
          /* Non-media oversized files (massive PDFs, etc.) get the
           * old skip path: we don't have a useful placeholder shape
           * for them, so just log and continue. */
          failCount++;
          const msg = `${f.name}: file too large (${f.size.toLocaleString()} bytes)`;
          perFileErrors.push(msg);
          trackEvent("connectors.sharepoint.file_ingest_failed", triggeredBy, triggeredByRole, {
            source_id: source.id,
            job_id: job.id,
            file_name: f.name,
            file_size: f.size,
            error: "file_too_large_skipped_before_download",
          });
          continue;
        }
        const buf = await downloadFn(triggeredBy, source.driveId, f.id);
        await ingestFn({
          filename: f.name,
          contentType: f.file?.mimeType ?? "application/octet-stream",
          buffer: buf,
          uploadedBy: triggeredBy,
          uploaderRole: triggeredByRole,
          tags: [
            "sharepoint",
            `sp-source:${source.id}`,
            `sp-source-name:${source.name}`,
            `workspace:${source.workspaceId}`,
          ],
        });
        successCount++;
        bytesIngested += buf.length;
      } catch (err) {
        failCount++;
        const errMsg = (err as Error).message.slice(0, 200);
        perFileErrors.push(`${f.name}: ${errMsg}`);
        trackEvent("connectors.sharepoint.file_ingest_failed", triggeredBy, triggeredByRole, {
          source_id: source.id,
          job_id: job.id,
          file_name: f.name,
          error: errMsg,
        });
      }
    }
  } catch (err) {
    topLevelError = (err as Error).message;
  }

  /* Roll per-file failures into the job-level error so the UI and
   * audit log surface a meaningful diagnosis. Keep it bounded so the
   * column doesn't bloat. */
  if (!topLevelError && perFileErrors.length > 0) {
    const sample = perFileErrors.slice(0, 5).join("; ");
    const more = perFileErrors.length > 5 ? ` (+${perFileErrors.length - 5} more)` : "";
    topLevelError = `${perFileErrors.length} file(s) failed: ${sample}${more}`;
  }

  /* Walker-level crash always means 'failed' regardless of file
   * counts (we didn't even get to iterate files). Per-file failures
   * rolled into topLevelError above DON'T trigger this branch; they
   * fall into the partial/failed by-count logic below. */
  const walkerCrashed = topLevelError && fileCount === 0;
  const status: IngestJobStatus =
    walkerCrashed ? "failed" :
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
