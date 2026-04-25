/**
 * meeting-insights — shared types for the org-wide "recurring meeting"
 * automation. Phase 1 = ingest + raw storage. Phase 2 = LLM analyzer.
 * Phase 3 = cross-meeting theme tracker. Phase 4 = calendar-brief
 * integration. Phase 5 = ad-hoc multi-term analysis.
 *
 * Reuses the existing automations registry / inbox poller / cron stack
 * from porsche-classes — see src/lib/automations/types.ts for the
 * AutomationDefinition shape. The meeting-insights automation
 * registers a SINGLE entry whose inbox_filters are the UNION of every
 * enabled MeetingFeed's filters; per-message routing in
 * `routeMessageToFeed` assigns each matched email to the right feed.
 *
 * Feeds are ORG-SHARED: created by any user with `meetings.manage`,
 * visible to any user with `meetings.view`. No per-user fan-out.
 *
 * Two streams build against this contract:
 *   - Stream A: schema, registry registration, feed CRUD APIs,
 *     dashboard pages, ingest router.
 *   - Stream B: parsers — email body (plain + HTML stripped to text),
 *     .docx / .pdf attachment text extraction. Phase 2 LLM analyzer
 *     is OUT OF SCOPE; ship raw + parsed text first.
 */

/** Stable id slug for a meeting feed — kebab-case, route-safe. */
export type MeetingFeedSlug = string;

/** Match modes for filters — "any" = OR within-list. */
export interface MeetingFeedFilters {
  /** Substring match against the From email address (lowercased). */
  sender_match: string[];
  /** Substring match against the Subject. */
  subject_match: string[];
  /** Optional: only ingest messages received on/after this ISO date. */
  since?: string;
}

export interface MeetingFeed {
  id: string;
  slug: MeetingFeedSlug;
  name: string;
  description: string | null;
  filters: MeetingFeedFilters;
  is_enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MeetingFeedInput {
  name: string;
  description?: string | null;
  filters: MeetingFeedFilters;
  is_enabled?: boolean;
}

/** One ingested email tied to one feed. */
export interface MeetingMessageRecord {
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
  /** Plain-text body (HTML stripped if needed). */
  body_text: string;
  /** Original HTML body, when available. Stored for fidelity. */
  body_html: string | null;
  has_attachments: boolean;
  created_at: string;
}

export interface MeetingAttachmentRecord {
  id: string;
  message_id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  /** Extracted plain text, when the parser supports the mime. Null
      when we stored bytes but couldn't parse — Phase 2 can revisit. */
  extracted_text: string | null;
  extraction_status: "extracted" | "unsupported_mime" | "error";
  /** Storage reference — bytes live in the artifact bytea or in object
      storage (Phase 2). For Phase 1 we keep them inline on the
      attachment row. */
  bytes: Buffer | null;
  created_at: string;
}

/** A single email-body parser: turn bytes/headers into MeetingMessageRecord
    fields. Lives in Stream B. */
export interface ParsedEmailBody {
  body_text: string;
  body_html: string | null;
}

/** A single attachment parser: turn bytes into extracted text. */
export type AttachmentExtractor = (
  bytes: Buffer,
  mime: string,
  filename: string,
) => Promise<{ text: string | null; status: "extracted" | "unsupported_mime" | "error" }>;
