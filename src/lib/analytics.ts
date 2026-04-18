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
  // Central Brain — team-wide document ingestion + RAG
  | "brain.upload_started"
  | "brain.upload_completed"
  | "brain.upload_rejected"
  | "brain.extraction_started"
  | "brain.extraction_succeeded"
  | "brain.extraction_failed"
  | "brain.chunked"
  | "brain.embedding_succeeded"
  | "brain.embedding_skipped"
  | "brain.document_indexed"
  | "brain.document_deleted"
  | "brain.query_issued"
  | "brain.query_hit"
  | "brain.query_miss"
  | "brain.query_cited_in_answer"
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
  // Microsoft 365 Tasks (To Do)
  | "system.ms_tasks_synced"
  | "system.ms_tasks_sync_failed"
  | "system.task_viewed"
  | "system.task_completed"
  | "system.task_created"
  // Microsoft Teams (personal chat) + OneNote
  | "system.ms_teams_chats_synced"
  | "system.ms_teams_messages_synced"
  | "system.ms_teams_sync_failed"
  | "system.ms_teams_sync_indexing_failed"
  | "system.ms_onenote_notebook_listed"
  | "system.ms_onenote_page_viewed"
  | "system.ms_onenote_page_created"
  | "system.ms_onenote_failed"
  // Microsoft 365 OneDrive Files
  | "system.ms_file_uploaded"
  | "system.ms_file_downloaded"
  | "system.ms_file_list_fetched"
  | "system.ms_file_operation_failed"
  // Microsoft 365 People suggestions
  | "system.ms_people_suggestions_fetched"
  // Microsoft 365 Presence
  | "system.ms_presence_fetched"
  // Microsoft 365 Contacts (write path)
  | "system.ms_contact_created"
  | "system.ms_contact_updated"
  | "system.ms_contact_deleted"
  | "system.ms_contacts_sync"
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
  | "site.archived"
  | "site.brief_auto_parsed"
  | "site.brief_parse_failed"
  | "site.brief_form_edited"
  | "site.dropzone_used"
  // Sites — prompt-to-brief editor (029)
  | "site.brief_edit_requested"
  | "site.brief_edit_generated"
  | "site.brief_edit_failed"
  | "site.brief_edit_blocked"
  | "site.brief_edit_decided"
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
  // HR benefits carrier detection
  | "hr.benefit_carrier_detected"
  | "hr.benefit_carrier_fallback"
  // HR documents (smart router across all uploaded forms)
  | "hr.document_uploaded"
  | "hr.document_classified"
  | "hr.document_recategorized"
  | "hr.document_linked_to_employee"
  | "hr.document_unlinked_from_employee"
  | "hr.document_deleted"
  | "hr.document_expired"
  | "hr.document_filed_via_benefits_tab"
  | "hr.document_filed_via_documents_tab"
  // HR document field extraction
  | "hr.document_fields_extracted"
  | "hr.document_extraction_empty"
  // HR onboarding
  | "hr.onboarding_started"
  | "hr.onboarding_step_completed"
  | "hr.onboarding_step_uncompleted"
  | "hr.onboarding_completed"
  | "hr.onboarding_cancelled"
  | "hr.onboarding_template_created"
  // Workspace setup
  | "system.setup_started"
  | "system.setup_step_viewed"
  | "system.setup_step_completed"
  | "system.setup_step_abandoned"
  | "system.setup_completed"
  | "system.setup_integration_connect_started"
  | "system.setup_integration_connect_succeeded"
  | "system.setup_integration_connect_failed"
  | "system.team_member_invited"
  | "system.team_invite_accepted"
  | "system.setup_banner_shown"
  // Security
  | "system.login_rate_limited"
  | "system.upload_rate_limited"
  | "system.unauthorized_access_attempt"
  | "system.token_signed"
  | "system.token_verified"
  | "system.token_verify_failed"
  | "system.refresh_token_rotated"
  | "system.refresh_token_reuse_detected"
  | "system.csp_violation_reported"
  | "system.security_posture_viewed"
  | "system.tls_hybrid_verified"
  // Audit log (compliance-grade record, separate from analytics)
  | "system.audit_log_written"
  | "system.audit_log_viewed"
  | "system.audit_log_tamper_suspected"
  | "system.audit_log_export"
  | "system.unusual_access_pattern"
  // Notifications (in-app + digest)
  | "system.notification_created"
  | "system.notification_read"
  | "system.notification_dismissed"
  | "system.notification_clicked"
  | "system.notification_digest_sent"
  | "system.notification_preferences_updated"
  // Capability / RBAC
  | "system.capability_denied"
  | "system.capability_granted_override"
  | "system.capability_revoked_override"
  | "system.role_changed"
  // Microsoft 365 Mail (Mail.Send)
  | "system.ms_mail_sent"
  | "system.ms_mail_reply_sent"
  | "system.ms_mail_send_failed"
  // Microsoft 365 Calendar (Calendars.ReadWrite)
  | "system.ms_calendar_event_created"
  | "system.ms_calendar_event_updated"
  | "system.ms_calendar_event_deleted"
  | "system.ms_calendar_operation_failed"
  // Microsoft 365 Planner (shared team tasks — Tier 2 · Stream D)
  | "system.ms_planner_synced"
  | "system.ms_planner_task_created"
  | "system.ms_planner_task_updated"
  | "system.ms_planner_task_completed"
  | "system.ms_planner_sync_failed"
  // Microsoft 365 Groups (Tier 2 · Stream D)
  | "system.ms_groups_synced"
  | "system.ms_groups_sync_failed"
  // Microsoft Teams channels (ChannelMessage.Read.All — Tier 2 · Stream E)
  | "system.ms_teams_channels_synced"
  | "system.ms_teams_channel_messages_synced"
  | "system.ms_teams_channel_sync_failed"
  | "system.ms_teams_channel_sync_indexing_failed"
  // Microsoft online meetings (OnlineMeetings.ReadWrite.All — Tier 2 · Stream E)
  | "system.ms_online_meeting_created"
  | "system.ms_online_meeting_updated"
  | "system.ms_online_meeting_failed"
  // Microsoft 365 Directory (Tier 2 · Stream B — tenant user cache)
  | "system.ms_directory_synced"
  | "system.ms_directory_sync_failed"
  | "system.ms_directory_user_fetched"
  // Microsoft 365 Mailbox settings (Tier 2 · Stream B — OOO / auto-reply)
  | "system.ms_mailbox_settings_fetched"
  | "system.ms_mailbox_ooo_detected"
  | "system.ms_mailbox_settings_failed"
  // Tools
  | "tools.pdf_generated"
  | "tools.demo_deck_captured"
  | "tools.visual_diff_run"
  | "tools.accessibility_checked"
  | "tools.page_viewed";

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
