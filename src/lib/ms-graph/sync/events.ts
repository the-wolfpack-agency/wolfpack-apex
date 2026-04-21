/**
 * MS Graph → canonical `instinct_ms_events` sync worker.
 *
 * Drains `/me/calendarview/delta`, upserts into instinct_ms_events, and
 * appends an entry to instinct_ms_change_log for every change. Graceful
 * on scope_missing / rate_limited / any other error — the unified
 * dispatcher in ./index.ts must still be able to run sibling workers.
 */

import { listCalendarEventsDelta, type GraphCalendarEvent } from "../client";
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

const SCOPE = "Calendars.Read";
const TABLE = "instinct_ms_events";

export async function syncUser(userId: string): Promise<SyncWorkerResult> {
  const startMs = Date.now();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  try {
    const cursor = await loadCursor(userId, "events");
    const { items, nextDeltaLink } = await listCalendarEventsDelta(userId, cursor);

    for (const ev of items) {
      if (ev["@removed"]) {
        if (await softDelete(TABLE, userId, ev.id)) {
          deleted += 1;
          await appendChangeLog(userId, "events", ev.id, "deleted");
        }
        continue;
      }

      const outcome = await upsertEvent(userId, ev);
      if (outcome === "inserted") {
        created += 1;
        await appendChangeLog(userId, "events", ev.id, "created");
      } else {
        updated += 1;
        await appendChangeLog(userId, "events", ev.id, "updated");
      }
    }

    if (nextDeltaLink) {
      await saveCursor(userId, "events", nextDeltaLink);
    }

    const result: SyncWorkerResult = {
      entityType: "events",
      created,
      updated,
      deleted,
      durationMs: Date.now() - startMs,
    };
    emitSynced(userId, "events", result);
    return result;
  } catch (err) {
    return errorToResult(userId, "events", SCOPE, startMs, err);
  }
}

async function upsertEvent(
  userId: string,
  ev: GraphCalendarEvent,
): Promise<"inserted" | "updated"> {
  const startAt = ev.start?.dateTime ? new Date(ev.start.dateTime).toISOString() : null;
  const endAt = ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : null;
  const occurredAt =
    ev.lastModifiedDateTime ??
    ev.createdDateTime ??
    new Date().toISOString();

  const attendees = Array.isArray(ev.attendees)
    ? ev.attendees.map((a) => ({
        name: a.emailAddress?.name ?? null,
        email: a.emailAddress?.address ?? null,
        type: a.type ?? null,
      }))
    : [];

  const normalized = {
    subject: ev.subject ?? null,
    bodyPreview: ev.bodyPreview ?? null,
    startAt,
    endAt,
    attendees,
    organizerEmail: ev.organizer?.emailAddress?.address ?? null,
    onlineMeeting: ev.isOnlineMeeting === true,
  };

  const { rows } = await writeQuery<{ inserted: boolean }>(
    `INSERT INTO instinct_ms_events
       (user_id, external_id, subject, body_preview,
        start_at, end_at, attendees, organizer_email, online_meeting,
        normalized_payload, raw_payload, occurred_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
             $10::jsonb, $11::jsonb, $12, now(), NULL)
     ON CONFLICT (user_id, external_id) DO UPDATE SET
       subject            = EXCLUDED.subject,
       body_preview       = EXCLUDED.body_preview,
       start_at           = EXCLUDED.start_at,
       end_at             = EXCLUDED.end_at,
       attendees          = EXCLUDED.attendees,
       organizer_email    = EXCLUDED.organizer_email,
       online_meeting     = EXCLUDED.online_meeting,
       normalized_payload = EXCLUDED.normalized_payload,
       raw_payload        = EXCLUDED.raw_payload,
       occurred_at        = EXCLUDED.occurred_at,
       updated_at         = now(),
       deleted_at         = NULL
     RETURNING (xmax = 0) AS inserted`,
    [
      userId,
      ev.id,
      ev.subject ?? null,
      ev.bodyPreview ?? null,
      startAt,
      endAt,
      JSON.stringify(attendees),
      ev.organizer?.emailAddress?.address ?? null,
      ev.isOnlineMeeting === true,
      JSON.stringify(normalized),
      JSON.stringify(ev),
      occurredAt,
    ],
    { expectRows: 1 },
  );
  return rows[0]?.inserted ? "inserted" : "updated";
}
