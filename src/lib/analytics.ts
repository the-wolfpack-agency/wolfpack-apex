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
  | "assistant.file_attached"
  | "assistant.doc_quality_checked"
  | "assistant.doc_rejected"
  | "assistant.doc_ingested"
  // QuickBooks
  | "quickbooks.api_called"
  | "quickbooks.connected"
  | "quickbooks.disconnected"
  | "quickbooks.token_refreshed"
  | "quickbooks.sync_completed"
  // Microsoft Graph
  | "microsoft.api_called"
  | "microsoft.connected"
  | "microsoft.disconnected"
  | "microsoft.token_refreshed"
  | "microsoft.token_refresh_failed"
  | "microsoft.fetch_failed"
  | "microsoft.sync_completed"
  // Briefing
  | "briefing.generated"
  | "briefing.viewed"
  | "briefing.refreshed"
  // Plaud (meeting transcripts)
  | "plaud.connected"
  | "plaud.disconnected"
  | "plaud.webhook_received"
  | "plaud.signature_invalid"
  | "plaud.transcript_ingested"
  | "plaud.transcript_rejected"
  | "plaud.transcript_duplicate"
  | "plaud.fetch_failed"
  | "plaud.no_owner"
  // Sites (Instinct → wolfpack-site-template)
  | "site.created"
  | "site.brief_updated"
  | "site.asset_uploaded"
  | "site.repo_provisioned"
  | "site.deploy_triggered"
  | "site.deploy_succeeded"
  | "site.deploy_failed"
  | "site.canary_passed"
  | "site.canary_failed"
  | "site.preview_viewed"
  | "site.link_shared"
  | "site.deleted"
  | "site.brief_auto_parsed"
  | "site.brief_parse_failed"
  | "site.brief_form_edited"
  | "site.dropzone_used"
  // People (HR) — benefits, employees, onboarding, insights
  | "hr.employee_added"
  | "hr.employee_updated"
  | "hr.employee_removed"
  | "hr.benefit_document_uploaded"
  | "hr.benefit_document_parsed"
  | "hr.benefit_document_parse_failed"
  | "hr.benefit_recommendation_generated"
  | "hr.benefit_recommendation_viewed"
  | "hr.benefit_recommendation_accepted"
  | "hr.benefit_recommendation_rejected"
  | "hr.benefit_plan_compared"
  | "hr.insight_generated"
  | "hr.insight_viewed"
  | "hr.insight_dismissed"
  // HR documents (smart router across all uploaded forms)
  | "hr.document_uploaded"
  | "hr.document_classified"
  | "hr.document_recategorized"
  | "hr.document_linked_to_employee"
  | "hr.document_unlinked_from_employee"
  | "hr.document_deleted"
  | "hr.document_expired"
  | "hr.document_filed_via_benefits_tab"
  | "hr.document_filed_via_documents_tab";

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
