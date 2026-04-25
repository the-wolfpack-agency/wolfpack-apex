/**
 * meeting-insights / messages-repo — message + attachment reads.
 *
 * Pure DB layer. The API routes own auth, analytics, audit; this file
 * just runs parameterized queries. Mirrors the `feeds-repo.ts`
 * convention.
 */

import { query } from "@/lib/db";
import type {
  MeetingMessageRecord,
  MeetingAttachmentRecord,
} from "./types";

interface MessageRow extends Record<string, unknown> {
  id: string;
  feed_id: string;
  source_message_id: string;
  artifact_id: string;
  subject: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  received_at: string;
  body_text: string;
  body_html: string | null;
  has_attachments: boolean;
  created_at: string;
}

function rowToMessage(row: MessageRow): MeetingMessageRecord {
  return {
    id: row.id,
    feed_id: row.feed_id,
    source_message_id: row.source_message_id,
    artifact_id: row.artifact_id,
    subject: row.subject,
    from_address: row.from_address,
    from_name: row.from_name,
    to_addresses: row.to_addresses ?? [],
    cc_addresses: row.cc_addresses ?? [],
    received_at:
      typeof row.received_at === "string"
        ? row.received_at
        : new Date(row.received_at).toISOString(),
    body_text: row.body_text,
    body_html: row.body_html,
    has_attachments: row.has_attachments,
    created_at:
      typeof row.created_at === "string"
        ? row.created_at
        : new Date(row.created_at).toISOString(),
  };
}

export async function listMessagesForFeed(args: {
  feed_id: string;
  limit?: number;
}): Promise<MeetingMessageRecord[]> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const r = await query<MessageRow>(
    `SELECT id, feed_id, source_message_id, artifact_id, subject,
            from_address, from_name, to_addresses, cc_addresses,
            received_at, body_text, body_html, has_attachments, created_at
       FROM instinct_meeting_messages
      WHERE feed_id = $1
      ORDER BY received_at DESC
      LIMIT $2`,
    [args.feed_id, limit],
  );
  return r.rows.map(rowToMessage);
}

export async function getMessage(args: {
  feed_id: string;
  message_id: string;
}): Promise<MeetingMessageRecord | null> {
  const r = await query<MessageRow>(
    `SELECT id, feed_id, source_message_id, artifact_id, subject,
            from_address, from_name, to_addresses, cc_addresses,
            received_at, body_text, body_html, has_attachments, created_at
       FROM instinct_meeting_messages
      WHERE feed_id = $1 AND id = $2
      LIMIT 1`,
    [args.feed_id, args.message_id],
  );
  return r.rows.length === 0 ? null : rowToMessage(r.rows[0]);
}

interface AttachmentRow extends Record<string, unknown> {
  id: string;
  message_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  extracted_text: string | null;
  extraction_status: "extracted" | "unsupported_mime" | "error";
  created_at: string;
}

/**
 * Lists attachment metadata for a message — does NOT include `bytes`.
 * Bytes are loaded separately via the (Stream B) download route, gated
 * by `meetings.export`.
 */
export async function listAttachmentsForMessage(
  message_id: string,
): Promise<Omit<MeetingAttachmentRecord, "bytes">[]> {
  const r = await query<AttachmentRow>(
    `SELECT id, message_id, filename, mime, size_bytes,
            extracted_text, extraction_status, created_at
       FROM instinct_meeting_attachments
      WHERE message_id = $1
      ORDER BY created_at ASC`,
    [message_id],
  );
  return r.rows.map((row) => ({
    id: row.id,
    message_id: row.message_id,
    filename: row.filename,
    mime: row.mime,
    size_bytes: row.size_bytes,
    extracted_text: row.extracted_text,
    extraction_status: row.extraction_status,
    created_at:
      typeof row.created_at === "string"
        ? row.created_at
        : new Date(row.created_at).toISOString(),
  }));
}
