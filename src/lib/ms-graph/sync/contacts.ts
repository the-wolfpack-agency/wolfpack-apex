/**
 * MS Graph → canonical `instinct_ms_contacts` sync worker (Outlook contacts).
 */

import { listContactsDelta, type GraphContact } from "../client";
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

const SCOPE = "Contacts.Read";
const TABLE = "instinct_ms_contacts";

export async function syncUser(userId: string): Promise<SyncWorkerResult> {
  const startMs = Date.now();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  try {
    const cursor = await loadCursor(userId, "contacts");
    const { items, nextDeltaLink } = await listContactsDelta(userId, cursor);

    for (const c of items) {
      if (c["@removed"]) {
        if (await softDelete(TABLE, userId, c.id)) {
          deleted += 1;
          await appendChangeLog(userId, "contacts", c.id, "deleted");
        }
        continue;
      }
      const outcome = await upsertContact(userId, c);
      if (outcome === "inserted") {
        created += 1;
        await appendChangeLog(userId, "contacts", c.id, "created");
      } else {
        updated += 1;
        await appendChangeLog(userId, "contacts", c.id, "updated");
      }
    }

    if (nextDeltaLink) {
      await saveCursor(userId, "contacts", nextDeltaLink);
    }

    const result: SyncWorkerResult = {
      entityType: "contacts",
      created,
      updated,
      deleted,
      durationMs: Date.now() - startMs,
    };
    emitSynced(userId, "contacts", result);
    return result;
  } catch (err) {
    return errorToResult(userId, "contacts", SCOPE, startMs, err);
  }
}

async function upsertContact(
  userId: string,
  c: GraphContact,
): Promise<"inserted" | "updated"> {
  const emails = Array.isArray(c.emailAddresses)
    ? c.emailAddresses
        .map((e) => e.address ?? null)
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const occurredAt =
    c.lastModifiedDateTime ??
    c.createdDateTime ??
    new Date().toISOString();

  const normalized = {
    displayName: c.displayName ?? null,
    emailAddresses: emails,
    companyName: c.companyName ?? null,
    jobTitle: c.jobTitle ?? null,
  };

  const { rows } = await writeQuery<{ inserted: boolean }>(
    `INSERT INTO instinct_ms_contacts
       (user_id, external_id, display_name, subject, body_preview,
        email_addresses, company_name,
        normalized_payload, raw_payload, occurred_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7,
             $8::jsonb, $9::jsonb, $10, now(), NULL)
     ON CONFLICT (user_id, external_id) DO UPDATE SET
       display_name       = EXCLUDED.display_name,
       subject            = EXCLUDED.subject,
       body_preview       = EXCLUDED.body_preview,
       email_addresses    = EXCLUDED.email_addresses,
       company_name       = EXCLUDED.company_name,
       normalized_payload = EXCLUDED.normalized_payload,
       raw_payload        = EXCLUDED.raw_payload,
       occurred_at        = EXCLUDED.occurred_at,
       updated_at         = now(),
       deleted_at         = NULL
     RETURNING (xmax = 0) AS inserted`,
    [
      userId,
      c.id,
      c.displayName ?? null,
      c.displayName ?? null, // mirror into shared "subject" column
      c.jobTitle ?? null,
      JSON.stringify(emails),
      c.companyName ?? null,
      JSON.stringify(normalized),
      JSON.stringify(c),
      occurredAt,
    ],
    { expectRows: 1 },
  );
  return rows[0]?.inserted ? "inserted" : "updated";
}
