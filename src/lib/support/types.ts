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

export interface SupportTicket {
  id: string;
  title: string;
  body: string;
  diagnostic_text: string | null;
  category: string;
  severity: SupportSeverity;
  status: SupportStatus;
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
  created_at: string;
  updated_at: string;
}

export interface CreateTicketInput {
  title: string;
  body: string;
  diagnostic_text?: string | null;
  category?: string;
  severity?: SupportSeverity;
  created_by_user_id: string;
  created_by_email?: string | null;
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
