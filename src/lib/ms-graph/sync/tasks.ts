/**
 * MS Graph → canonical `instinct_ms_tasks` sync worker.
 *
 * Drains every user task list via /me/todo/lists/{id}/tasks/delta (the
 * low-level helper in ../client wraps the per-list cursor map). Each
 * upsert/delete appends to instinct_ms_change_log.
 */

import { listTasksDelta, type GraphTask } from "../client";
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

const SCOPE = "Tasks.ReadWrite";
const TABLE = "instinct_ms_tasks";

export async function syncUser(userId: string): Promise<SyncWorkerResult> {
  const startMs = Date.now();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  try {
    const cursor = await loadCursor(userId, "tasks");
    const { items, nextDeltaLink } = await listTasksDelta(userId, cursor);

    for (const t of items) {
      if (t["@removed"]) {
        if (await softDelete(TABLE, userId, t.id)) {
          deleted += 1;
          await appendChangeLog(userId, "tasks", t.id, "deleted");
        }
        continue;
      }
      const outcome = await upsertTask(userId, t);
      if (outcome === "inserted") {
        created += 1;
        await appendChangeLog(userId, "tasks", t.id, "created");
      } else {
        updated += 1;
        await appendChangeLog(userId, "tasks", t.id, "updated");
      }
    }

    if (nextDeltaLink) {
      await saveCursor(userId, "tasks", nextDeltaLink);
    }

    const result: SyncWorkerResult = {
      entityType: "tasks",
      created,
      updated,
      deleted,
      durationMs: Date.now() - startMs,
    };
    emitSynced(userId, "tasks", result);
    return result;
  } catch (err) {
    return errorToResult(userId, "tasks", SCOPE, startMs, err);
  }
}

async function upsertTask(
  userId: string,
  t: GraphTask,
): Promise<"inserted" | "updated"> {
  const dueAt = t.dueDateTime?.dateTime
    ? new Date(t.dueDateTime.dateTime).toISOString()
    : null;
  const occurredAt =
    t.lastModifiedDateTime ??
    t.createdDateTime ??
    new Date().toISOString();

  const bodyPreview =
    typeof t.body?.content === "string"
      ? t.body.content.slice(0, 280)
      : null;

  const normalized = {
    title: t.title ?? null,
    status: t.status ?? null,
    importance: t.importance ?? null,
    dueAt,
    bodyPreview,
  };

  const { rows } = await writeQuery<{ inserted: boolean }>(
    `INSERT INTO instinct_ms_tasks
       (user_id, external_id, subject, body_preview, status, due_at, importance,
        normalized_payload, raw_payload, occurred_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8::jsonb, $9::jsonb, $10, now(), NULL)
     ON CONFLICT (user_id, external_id) DO UPDATE SET
       subject            = EXCLUDED.subject,
       body_preview       = EXCLUDED.body_preview,
       status             = EXCLUDED.status,
       due_at             = EXCLUDED.due_at,
       importance         = EXCLUDED.importance,
       normalized_payload = EXCLUDED.normalized_payload,
       raw_payload        = EXCLUDED.raw_payload,
       occurred_at        = EXCLUDED.occurred_at,
       updated_at         = now(),
       deleted_at         = NULL
     RETURNING (xmax = 0) AS inserted`,
    [
      userId,
      t.id,
      t.title ?? null,
      bodyPreview,
      t.status ?? null,
      dueAt,
      t.importance ?? null,
      JSON.stringify(normalized),
      JSON.stringify(t),
      occurredAt,
    ],
    { expectRows: 1 },
  );
  return rows[0]?.inserted ? "inserted" : "updated";
}
