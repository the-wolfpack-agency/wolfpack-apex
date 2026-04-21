/**
 * MS Graph → canonical `instinct_ms_files` sync worker (OneDrive).
 *
 * Syncs the user's root drive by default. A future extension can iterate
 * shared drives by calling `syncUserForDrive(userId, driveId)`.
 */

import { listFilesDelta, type GraphDriveItem } from "../client";
import { writeQuery } from "@/lib/db";
import {
  appendChangeLog,
  emitSynced,
  errorToResult,
  loadCursor,
  saveCursor,
  softDelete,
  type SyncWorkerResult,
} from "./common";

const SCOPE = "Files.Read.All";
const TABLE = "instinct_ms_files";

export async function syncUser(userId: string): Promise<SyncWorkerResult> {
  return syncUserForDrive(userId);
}

export async function syncUserForDrive(
  userId: string,
  driveId?: string,
): Promise<SyncWorkerResult> {
  const startMs = Date.now();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  try {
    const cursor = await loadCursor(userId, "files");
    const { items, nextDeltaLink } = await listFilesDelta(userId, driveId, cursor);

    for (const f of items) {
      if (f["@removed"]) {
        if (await softDelete(TABLE, userId, f.id)) {
          deleted += 1;
          await appendChangeLog(userId, "files", f.id, "deleted");
        }
        continue;
      }
      const outcome = await upsertFile(userId, f);
      if (outcome === "inserted") {
        created += 1;
        await appendChangeLog(userId, "files", f.id, "created");
      } else {
        updated += 1;
        await appendChangeLog(userId, "files", f.id, "updated");
      }
    }

    if (nextDeltaLink) {
      await saveCursor(userId, "files", nextDeltaLink);
    }

    const result: SyncWorkerResult = {
      entityType: "files",
      created,
      updated,
      deleted,
      durationMs: Date.now() - startMs,
    };
    emitSynced(userId, "files", result);
    return result;
  } catch (err) {
    return errorToResult(userId, "files", SCOPE, startMs, err);
  }
}

async function upsertFile(
  userId: string,
  f: GraphDriveItem,
): Promise<"inserted" | "updated"> {
  const size = typeof f.size === "number" ? f.size : null;
  const mime = f.file?.mimeType ?? null;
  const parentDrive = f.parentReference?.driveId ?? null;
  const occurredAt =
    f.lastModifiedDateTime ??
    f.createdDateTime ??
    new Date().toISOString();

  const normalized = {
    name: f.name ?? null,
    webUrl: f.webUrl ?? null,
    size,
    mimeType: mime,
    driveId: parentDrive,
    isFolder: !!f.folder,
    parentPath: f.parentReference?.path ?? null,
  };

  const { rows } = await writeQuery<{ inserted: boolean }>(
    `INSERT INTO instinct_ms_files
       (user_id, external_id, subject, body_preview,
        drive_id, web_url, size_bytes, mime_type,
        normalized_payload, raw_payload, occurred_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             $9::jsonb, $10::jsonb, $11, now(), NULL)
     ON CONFLICT (user_id, external_id) DO UPDATE SET
       subject            = EXCLUDED.subject,
       body_preview       = EXCLUDED.body_preview,
       drive_id           = EXCLUDED.drive_id,
       web_url            = EXCLUDED.web_url,
       size_bytes         = EXCLUDED.size_bytes,
       mime_type          = EXCLUDED.mime_type,
       normalized_payload = EXCLUDED.normalized_payload,
       raw_payload        = EXCLUDED.raw_payload,
       occurred_at        = EXCLUDED.occurred_at,
       updated_at         = now(),
       deleted_at         = NULL
     RETURNING (xmax = 0) AS inserted`,
    [
      userId,
      f.id,
      f.name ?? null,
      f.parentReference?.path ?? null,
      parentDrive,
      f.webUrl ?? null,
      size,
      mime,
      JSON.stringify(normalized),
      JSON.stringify(f),
      occurredAt,
    ],
    { expectRows: 1 },
  );
  return rows[0]?.inserted ? "inserted" : "updated";
}
