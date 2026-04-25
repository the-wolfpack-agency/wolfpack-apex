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
 * Phase 5 — ad-hoc query across already-ingested messages. Joins
 * feeds so callers get the feed slug/name on each row without an N+1
 * lookup. Filters are arrays of substrings; ANY match within an array
 * (OR), ALL arrays must match if non-empty (AND).
 *
 * subject_match / sender_match are case-insensitive ILIKE patterns.
 * Empty arrays mean "no constraint on that axis".
 */
export interface SearchedMessageRecord extends MeetingMessageRecord {
  feed_slug: string;
  feed_name: string;
}

export async function searchMessages(args: {
  subject_match: string[];
  sender_match: string[];
  since?: string;
  until?: string;
  limit?: number;
}): Promise<SearchedMessageRecord[]> {
  const limit = Math.min(Math.max(args.limit ?? 500, 1), 2000);

  // Build dynamic WHERE — every condition is parameterized.
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (args.subject_match.length > 0) {
    const ors: string[] = [];
    for (const s of args.subject_match) {
      params.push(`%${s}%`);
      ors.push(`m.subject ILIKE $${i++}`);
    }
    where.push(`(${ors.join(" OR ")})`);
  }
  if (args.sender_match.length > 0) {
    const ors: string[] = [];
    for (const s of args.sender_match) {
      params.push(`%${s.toLowerCase()}%`);
      ors.push(`LOWER(m.from_address) ILIKE $${i++}`);
    }
    where.push(`(${ors.join(" OR ")})`);
  }
  if (args.since) {
    params.push(args.since);
    where.push(`m.received_at >= $${i++}`);
  }
  if (args.until) {
    params.push(args.until);
    where.push(`m.received_at <= $${i++}`);
  }

  params.push(limit);
  const limitIdx = i++;

  const sql = `
    SELECT m.id, m.feed_id, m.source_message_id, m.artifact_id, m.subject,
           m.from_address, m.from_name, m.to_addresses, m.cc_addresses,
           m.received_at, m.body_text, m.body_html, m.has_attachments,
           m.created_at,
           f.slug AS feed_slug, f.name AS feed_name
      FROM instinct_meeting_messages m
      JOIN instinct_meeting_feeds f ON f.id = m.feed_id
     ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY m.received_at DESC
     LIMIT $${limitIdx}
  `;

  interface SearchRow extends MessageRow {
    feed_slug: string;
    feed_name: string;
  }
  const r = await query<SearchRow>(sql, params);
  return r.rows.map((row) => ({
    ...rowToMessage(row),
    feed_slug: row.feed_slug,
    feed_name: row.feed_name,
  }));
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
