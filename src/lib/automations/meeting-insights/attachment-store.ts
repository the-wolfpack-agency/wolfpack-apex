/**
 * Read-side helpers for meeting attachments.
 *
 * Stream B (this file) defines the lookup contract that the
 * `/download` and `/text` routes need; Stream A owns the schema +
 * write path. This module is thin SQL — when Stream A's migration
 * lands, the table name `instinct_meeting_attachments` will
 * be live; until then the queries no-op against a missing table and
 * the route tests stub this module entirely.
 *
 * Why a separate module: the routes test cleanly when the store is
 * mockable. We avoid pulling pg into the route's own test file.
 */

import { query } from "@/lib/db";

/**
 * Subset of MeetingAttachmentRecord the download/text routes need.
 *
 * `feed_slug` is the join target on the URL path — every attachment is
 * scoped to a feed via its message; the route asserts the feed slug in
 * the URL matches the attachment's feed before serving bytes.
 */
export interface MeetingAttachmentForServe {
  id: string;
  message_id: string;
  feed_slug: string;
  filename: string;
  mime: string;
  size_bytes: number;
  extracted_text: string | null;
  extraction_status: "extracted" | "unsupported_mime" | "error";
  bytes: Buffer | null;
}

/**
 * Resolve an attachment by feed slug + message id + attachment id.
 * Returns null when any of the path segments don't line up — that lets
 * the routes return a clean 404 without leaking which segment failed.
 *
 * SQL is parameterized; column / table names match the contract Stream
 * A is shipping. If Stream A renames anything at merge time, the
 * change is one query string.
 */
export async function getAttachmentForServe(
  feedSlug: string,
  messageId: string,
  attachmentId: string,
): Promise<MeetingAttachmentForServe | null> {
  const sql = `
    SELECT a.id,
           a.message_id,
           f.slug AS feed_slug,
           a.filename,
           a.mime,
           a.size_bytes,
           a.extracted_text,
           a.extraction_status,
           a.bytes
      FROM instinct_meeting_attachments a
      JOIN instinct_meeting_messages m ON m.id = a.message_id
      JOIN instinct_meeting_feeds    f ON f.id = m.feed_id
     WHERE f.slug = $1
       AND a.message_id = $2
       AND a.id = $3
     LIMIT 1
  `;
  const result = await query<Record<string, unknown>>(sql, [
    feedSlug,
    messageId,
    attachmentId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    message_id: String(row.message_id),
    feed_slug: String(row.feed_slug),
    filename: String(row.filename),
    mime: String(row.mime),
    size_bytes: Number(row.size_bytes),
    extracted_text: row.extracted_text == null ? null : String(row.extracted_text),
    extraction_status: row.extraction_status as MeetingAttachmentForServe["extraction_status"],
    bytes: row.bytes == null ? null : (row.bytes as Buffer),
  };
}
