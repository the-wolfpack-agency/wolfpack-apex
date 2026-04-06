/**
 * Apex Analytics — Every interaction feeds the learning loop.
 *
 * Zero-token-first: analytics are stored in PostgreSQL, not sent to AI.
 * The learning loop reads these events to improve knowledge retrieval,
 * surface popular questions, and identify documentation gaps.
 *
 * Event flow:
 *   User action → trackEvent() → INSERT analytics_events → learning views consume
 */

import { query } from "@/lib/db";
import { tripleWriteEvent } from "@/lib/triple-write";

export type ApexEventType =
  // Knowledge
  | "knowledge.question_asked"
  | "knowledge.answer_found"
  | "knowledge.answer_not_found"
  | "knowledge.answer_rated"
  | "knowledge.doc_generated"
  | "knowledge.doc_downloaded"
  | "knowledge.doc_revised"
  | "knowledge.codebase_searched"
  // Journal
  | "journal.entry_created"
  | "journal.entry_updated"
  | "journal.context_added"
  // Feature requests
  | "feature.request_submitted"
  | "feature.request_analyzed"
  | "feature.request_approved"
  | "feature.request_rejected"
  | "feature.cost_estimated"
  // Discussions
  | "discussion.thread_created"
  | "discussion.reply_posted"
  | "discussion.resolved"
  | "discussion.doc_attached"
  // Prototypes
  | "prototype.created"
  | "prototype.deployed"
  | "prototype.shared"
  | "prototype.archived"
  // Client
  | "client.doc_generated"
  | "client.email_drafted"
  | "client.proposal_created"
  // System
  | "system.login"
  | "system.page_viewed"
  | "system.ai_call_made"
  | "system.ai_call_skipped"
  | "system.search_performed"
  | "system.analytics_queried"
  // Assistant
  | "assistant.file_attached";

export interface ApexEvent {
  event_type: ApexEventType;
  user_id: string;
  user_role: string;
  metadata: Record<string, string | number | boolean>;
  timestamp?: string;
}

/**
 * Track an event. Fire-and-forget — never blocks, never throws.
 */
export function trackEvent(
  event: ApexEventType,
  userId: string,
  userRole: string,
  metadata: Record<string, string | number | boolean> = {},
): void {
  if (!process.env.DATABASE_URL) return;

  const ts = new Date().toISOString();
  query(
    `INSERT INTO apex_events (event_type, user_id, user_role, metadata, timestamp)
     VALUES ($1, $2, $3, $4, $5)`,
    [event, userId, userRole, JSON.stringify({ ...metadata, ts }), ts],
  ).catch((err) => {
    console.warn("[analytics] Failed to track:", (err as Error).message);
  });

  // Fire-and-forget: secondary writes to Qdrant + Neo4j
  tripleWriteEvent({
    event_type: event,
    user_id: userId,
    user_role: userRole,
    metadata,
  }).catch(() => {});
}

/**
 * Get event counts by type for a time range (for the learning loop).
 */
export async function getEventCounts(
  sinceHours: number = 24,
): Promise<Record<string, number>> {
  if (!process.env.DATABASE_URL) return {};
  try {
    const result = await query(
      `SELECT event_type, COUNT(*)::int AS count
       FROM apex_events
       WHERE timestamp > NOW() - INTERVAL '1 hour' * $1
       GROUP BY event_type
       ORDER BY count DESC`,
      [sinceHours],
    );
    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.event_type as string] = row.count as number;
    }
    return counts;
  } catch {
    return {};
  }
}
