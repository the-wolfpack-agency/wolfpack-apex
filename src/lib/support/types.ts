/**
 * support / types — shared types for the support feature.
 *
 * Mirrors the columns of instinct_support_tickets + instinct_support_patterns
 * one-to-one. Keep these in lockstep with migration 100_support.sql.
 *
 * `MatchSignature` is the JSONB shape inside `match_signatures`. The
 * pattern library never trusts the DB blindly — it validates every row
 * through the type guard below before compiling regex.
 */

export type SupportSeverity = "p0" | "p1" | "p2" | "p3";

export type SupportStatus =
  | "open"
  | "drafted"
  | "sent"
  | "resolved"
  | "closed";

/**
 * Audience for a support ticket:
 *   - 'client'   — request from a paying client / dealer principal.
 *                  Replies go from support@thewolfpack.agency.
 *   - 'internal' — request from a Wolfpack teammate. Replies go from the
 *                  operator's personal address.
 *
 * The runtime list is exported so API routes and UI form selects can
 * validate without re-declaring the literal.
 */
export type SupportAudience = "client" | "internal";

export const AUDIENCE_VALUES = ["client", "internal"] as const;

/**
 * Provenance of the `category` value on a ticket. Used by the UI to
 * decide whether to render a "?" indicator (AI + low confidence) and
 * by the learning loop to compute classifier precision.
 */
export type SupportCategorySource = "manual" | "ai";

/**
 * Append-only audit entry on a ticket's category_history JSONB column.
 * Each entry records a category change. Never edited in place — the
 * repo helper always pushes a new entry so the history is replay-safe.
 */
export interface SupportCategoryHistoryEntry {
  category: string;
  source: SupportCategorySource;
  confidence?: number | null;
  at: string;
}

export interface SupportTicket {
  id: string;
  title: string;
  body: string;
  diagnostic_text: string | null;
  category: string;
  severity: SupportSeverity;
  status: SupportStatus;
  audience: SupportAudience;
  created_by_user_id: string;
  created_by_email: string | null;
  draft_response: string | null;
  draft_generated_at: string | null;
  draft_pattern_ids: string[];
  sent_response: string | null;
  sent_at: string | null;
  sent_to_email: string | null;
  helpful: boolean | null;
  edit_diff: Record<string, unknown> | null;
  feedback_notes: string | null;
  feedback_at: string | null;
  /**
   * Microsoft Graph message id of the email that started the ticket
   * (when the ticket was auto-created by the inbox poller). Used by the
   * send route to call /messages/{id}/reply so the outbound message
   * lands on the same conversation thread instead of starting a new one.
   * Null for tickets created via the manual /support form.
   */
  graph_message_id: string | null;
  /**
   * RFC 5322 Message-ID of the inbound email. Survives mailbox moves
   * and is what other mail clients use to thread, so we keep it for
   * cross-system thread reconciliation.
   */
  graph_internet_message_id: string | null;
  /**
   * Microsoft Graph conversationId. The poller uses this to detect
   * "customer replied to our reply" and route the new message onto the
   * existing ticket instead of creating a duplicate.
   */
  graph_conversation_id: string | null;
  /**
   * Provenance of `category`. 'manual' (operator picked) or 'ai'
   * (auto-categorizer). Defaults to 'manual' on rows created before
   * migration 103 and on any explicit operator pick.
   */
  category_source?: SupportCategorySource;
  /**
   * Confidence (0..1) the AI had when it picked `category`. Null/absent
   * for operator-picked categories.
   */
  category_confidence?: number | null;
  /**
   * Append-only audit trail of every category change on this ticket.
   * The latest entry is always the one whose values are reflected in
   * `category` / `category_source` / `category_confidence`.
   */
  category_history?: SupportCategoryHistoryEntry[];
  created_at: string;
  updated_at: string;
}

export interface CreateTicketInput {
  title: string;
  body: string;
  diagnostic_text?: string | null;
  category?: string;
  severity?: SupportSeverity;
  audience?: SupportAudience;
  created_by_user_id: string;
  created_by_email?: string | null;
  /** Set by the inbox poller when the ticket is born from an inbound
   *  email. Manual /support form leaves these undefined. */
  graph_message_id?: string | null;
  graph_internet_message_id?: string | null;
  graph_conversation_id?: string | null;
}

export interface RecordFeedbackInput {
  ticket_id: string;
  helpful: boolean;
  edit_diff?: Record<string, unknown> | null;
  feedback_notes?: string | null;
}

export interface MarkSentInput {
  ticket_id: string;
  sent_response: string;
  sent_to_email: string;
}

export type MatchSignature =
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "substring"; pattern: string; case_insensitive?: boolean };

export interface SupportPattern {
  id: string;
  slug: string;
  name: string;
  category: string;
  match_signatures: MatchSignature[];
  draft_template: string;
  success_count: number;
  fail_count: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export function isMatchSignature(v: unknown): v is MatchSignature {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.type === "regex") {
    return typeof o.pattern === "string"
      && (o.flags === undefined || typeof o.flags === "string");
  }
  if (o.type === "substring") {
    return typeof o.pattern === "string"
      && (o.case_insensitive === undefined
        || typeof o.case_insensitive === "boolean");
  }
  return false;
}
