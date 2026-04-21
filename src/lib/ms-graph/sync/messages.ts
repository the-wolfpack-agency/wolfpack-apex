/**
 * MS Graph → canonical `instinct_ms_messages` sync worker (Outlook inbox).
 */

import { listMailDelta, type GraphMailMessage } from "../client";
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

const SCOPE = "Mail.Read";
const TABLE = "instinct_ms_messages";

export async function syncUser(userId: string): Promise<SyncWorkerResult> {
  const startMs = Date.now();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  try {
    const cursor = await loadCursor(userId, "messages");
    const { items, nextDeltaLink } = await listMailDelta(userId, cursor);

    for (const m of items) {
      if (m["@removed"]) {
        if (await softDelete(TABLE, userId, m.id)) {
          deleted += 1;
          await appendChangeLog(userId, "messages", m.id, "deleted");
        }
        continue;
      }
      const outcome = await upsertMessage(userId, m);
      if (outcome === "inserted") {
        created += 1;
        await appendChangeLog(userId, "messages", m.id, "created");
      } else {
        updated += 1;
        await appendChangeLog(userId, "messages", m.id, "updated");
      }
    }

    if (nextDeltaLink) {
      await saveCursor(userId, "messages", nextDeltaLink);
    }

    const result: SyncWorkerResult = {
      entityType: "messages",
      created,
      updated,
      deleted,
      durationMs: Date.now() - startMs,
    };
    emitSynced(userId, "messages", result);
    return result;
  } catch (err) {
    return errorToResult(userId, "messages", SCOPE, startMs, err);
  }
}

async function upsertMessage(
  userId: string,
  m: GraphMailMessage,
): Promise<"inserted" | "updated"> {
  const toEmails = Array.isArray(m.toRecipients)
    ? m.toRecipients
        .map((r) => r.emailAddress?.address ?? null)
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const fromEmail = m.from?.emailAddress?.address ?? null;
  const occurredAt =
    m.receivedDateTime ??
    m.lastModifiedDateTime ??
    new Date().toISOString();

  const normalized = {
    subject: m.subject ?? null,
    bodyPreview: m.bodyPreview ?? null,
    fromEmail,
    toEmails,
    hasAttachments: m.hasAttachments === true,
    receivedAt: m.receivedDateTime ?? null,
  };

  const { rows } = await writeQuery<{ inserted: boolean }>(
    `INSERT INTO instinct_ms_messages
       (user_id, external_id, subject, body_preview,
        from_email, to_emails, has_attachments,
        normalized_payload, raw_payload, occurred_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7,
             $8::jsonb, $9::jsonb, $10, now(), NULL)
     ON CONFLICT (user_id, external_id) DO UPDATE SET
       subject            = EXCLUDED.subject,
       body_preview       = EXCLUDED.body_preview,
       from_email         = EXCLUDED.from_email,
       to_emails          = EXCLUDED.to_emails,
       has_attachments    = EXCLUDED.has_attachments,
       normalized_payload = EXCLUDED.normalized_payload,
       raw_payload        = EXCLUDED.raw_payload,
       occurred_at        = EXCLUDED.occurred_at,
       updated_at         = now(),
       deleted_at         = NULL
     RETURNING (xmax = 0) AS inserted`,
    [
      userId,
      m.id,
      m.subject ?? null,
      m.bodyPreview ?? null,
      fromEmail,
      JSON.stringify(toEmails),
      m.hasAttachments === true,
      JSON.stringify(normalized),
      JSON.stringify(m),
      occurredAt,
    ],
    { expectRows: 1 },
  );
  return rows[0]?.inserted ? "inserted" : "updated";
}
