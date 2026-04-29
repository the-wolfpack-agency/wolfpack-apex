/**
 * Instinct Analytics — Every interaction feeds the learning loop.
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

export type InstinctEventType =
  // Knowledge
  | "knowledge.question_asked"
  | "knowledge.answer_found"
  | "knowledge.answer_not_found"
  | "knowledge.answer_rated"
  | "knowledge.doc_generated"
  | "knowledge.doc_downloaded"
  | "knowledge.doc_revised"
  // Documents (generated docs page) — edit/delete. Separate from the legacy
  // knowledge.doc_* events so the learning loop can distinguish generator
  // churn from human curation.
  //   docs.edited   { doc_id }
  //   docs.deleted  { doc_id }
  | "docs.edited"
  | "docs.deleted"
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
  // Brain Pack Level-2 (client-side ANN over cached pack chunks).
  //
  //   brain.embedding_model_loaded        { duration_ms, size_bytes }
  //     — the lazy transformers.js MiniLM pipeline finished its first
  //       load. `size_bytes` is a best-effort total of fetched weight
  //       bytes; 0 when the loader could not observe the network.
  //
  //   brain.embedding_model_load_failed   { error }
  //     — load failed or timed out. The caller falls back to the
  //       Level-1 fingerprint path; the user still sees cached results
  //       when available.
  //
  //   brain.query_embedded                { duration_ms }
  //     — per-call embedding timing, not including model load. Lets the
  //       learning loop see the steady-state encode cost.
  //
  //   brain.ann_search_performed          { workspace, chunk_count,
  //                                          top_k, duration_ms }
  //     — one full Level-2 search finished. `chunk_count` is the number
  //       of pack chunks we scored against; `duration_ms` includes
  //       keyword + semantic + merge.
  //
  //   rag.served_from_pack                { workspace, top_score,
  //                                          is_fuzzy }
  //     — fires on every Level-2 hit that returns to the caller, so
  //       the offline-hit dashboards can distinguish pack-served from
  //       fingerprint-served cache hits.
  | "brain.embedding_model_loaded"
  | "brain.embedding_model_load_failed"
  | "brain.query_embedded"
  | "brain.ann_search_performed"
  | "rag.served_from_pack"
  // Brain Pack Level-2 — progressive download / sync lifecycle (Stream U3).
  //
  //   brain.pack_sync_started      { workspace, resume }
  //     — a sync cycle kicked off. `resume` is true when we're continuing
  //       a previously-aborted sync by carrying the server cursor forward.
  //
  //   brain.pack_page_downloaded   { workspace, page_chunks, total_cached,
  //                                   duration_ms }
  //     — one page landed in IDB. `total_cached` is the running count of
  //       cached chunks for the workspace AFTER this page applied.
  //
  //   brain.pack_sync_completed    { workspace, downloaded, skipped,
  //                                   failed, duration_ms }
  //     — the sync finished naturally (no more pages / cursor exhausted).
  //
  //   brain.pack_sync_skipped      { reason }
  //     — the sync was short-circuited before any network. `reason` is
  //       one of "save_data" | "cellular" | "offline" | "quota_exceeded"
  //       | "already_running". Save-data + cellular respect user prefs;
  //       quota_exceeded fires after a QuotaExceededError from IDB.
  //
  //   brain.pack_chunk_evicted     { workspace, reason }
  //     — a cached chunk was evicted (workspace cleared, LRU trim on
  //       quota pressure, doc removed server-side). `reason` ∈
  //       "workspace_cleared" | "quota_pressure" | "stale".
  | "brain.pack_sync_started"
  | "brain.pack_page_downloaded"
  | "brain.pack_sync_completed"
  | "brain.pack_sync_skipped"
  | "brain.pack_chunk_evicted"
  // Journal
  | "journal.entry_created"
  | "journal.entry_updated"
  | "journal.context_added"
  // Journal UX — density toggle + day-group collapse so the learning loop
  // can see which density users prefer and whether default-collapsing old
  // days actually shortens the scroll as designed.
  //   journal.density_toggled: { density: "compact"|"comfortable" }
  //   journal.group_collapsed: { date: "YYYY-MM-DD", collapsed: boolean }
  | "journal.density_toggled"
  | "journal.group_collapsed"
  // Offline draft creation (Path C · Stream U1 — text-draft offline)
  //
  // Fires ONLY on the queue path (i.e. the user created the draft
  // offline or the server was unreachable). Online inline creates do
  // NOT fire these — the underlying create endpoint already emits its
  // own event (journal.entry_updated, meeting.transcript_ingested,
  // knowledge.question_asked, ...). The `offline.mutation_queued`
  // event fires for every queued mutation, but these per-feature
  // events let dashboards slice by feature without having to parse
  // the generic `endpoint` metadata.
  //
  //   meeting.draft_created_offline   { resource_type, draft_id }
  //   journal.entry_created_offline   { resource_type, entry_id }
  //   knowledge.entry_created_offline { resource_type, entry_id }
  | "meeting.draft_created_offline"
  | "journal.entry_created_offline"
  | "knowledge.entry_created_offline"
  | "knowledge.entry_updated_offline"
  | "knowledge.entry_deleted_offline"
  | "knowledge.entry_edit_clicked"
  | "knowledge.entry_delete_clicked"
  | "knowledge.entry_created"
  | "knowledge.entry_updated"
  | "knowledge.entry_deleted"
  // Simplified "quick add" path — one textarea + optional title. Fires on
  // submit so the learning loop can grade how often users reach for the
  // simple path vs the Advanced structured form.
  //   knowledge.quick_add: { used_title: boolean, content_length: number,
  //                           classified_as: "qa"|"note" }
  | "knowledge.quick_add"
  // Goals (company OKRs / KRs / contributions — migration 079).
  // Fires from Goals dashboard tile, OKR cards, Friday-sync commitment
  // flow, auto-linker, and offline queue. All are consumed by the
  // learning loop to grade forecast accuracy and surface stalled KRs.
  | "goal.page_viewed"
  | "goal.okr_created"
  | "goal.okr_created_ui"
  | "goal.kr_added"
  | "goal.kr_edited"
  | "goal.kr_deleted"
  | "goal.okr_archived"
  | "goal.okr_edited"
  | "goal.north_star_edited"
  | "goal.north_star_deleted"
  | "goal.contribution_edited"
  | "goal.contribution_deleted"
  | "goal.kr_updated"
  | "goal.contribution_created"
  | "goal.contribution_graded"
  | "goal.commitment_ui_submitted"
  | "goal.commitment_ui_graded"
  | "goal.commitment_queued_offline"
  | "goal.north_star_ui_updated"
  | "goal.digest_sent"
  // Team fanout when an admin (ceo|cto) creates/edits a company goal.
  // Feeds the learning loop with { goal_type, action, recipient_count,
  // actor_role } so we can see which admins drive the most team
  // attention + whether certain goal types get ignored.
  | "goals.team_notified"
  // Polymorphic entity tag/link layer (migration 078).
  | "entity.tag_applied"
  | "entity.tag_removed"
  | "entity.link_created"
  | "entity.link_removed"
  | "entity.auto_tag_run"
  // MS Graph canonical-mirror sync (migration 077 L1).
  | "ms_sync.user_synced"
  | "ms_sync.scope_missing"
  | "ms_sync.error"
  | "ms_sync.rate_limited"
  // Meeting pre-brief (5-min-before context panel: attendees, recent
  // email threads with them, their open tasks, linked goal, last
  // decision). View events feed the learning loop so we can grade
  // which prebrief signals actually got clicked.
  // Calendar page — week/month/year views + suggestion engagement.
  | "calendar.page_viewed"
  | "calendar.view_changed"
  | "calendar.range_computed"
  | "calendar.suggestion_viewed"
  | "calendar.suggestion_acted_on"
  // Calendar meeting link click-through — fired when the user clicks the
  // subject link (webLink → Outlook) OR the explicit "Join" button
  // (onlineMeeting.joinUrl → Teams). Metadata distinguishes which surface
  // was used so the learning loop can see whether designers prefer to
  // open the full Outlook context or jump straight into the Teams call.
  //   calendar.meeting_opened_external: { event_id, target: "web"|"join" }
  | "calendar.meeting_opened_external"
  | "meeting.prebrief_computed"
  | "meeting.prebrief_viewed"
  | "meeting.prebrief_section_expanded"
  | "meeting.prebrief_meeting_selected"
  | "meeting.upcoming_fetched"
  // Meeting-Insights ingest (org-shared automation feeds — Stream B).
  //   meeting_insights.attachment_downloaded   { feed_slug, message_id,
  //                                              attachment_id, filename,
  //                                              mime, size_bytes }
  //     — fires when a user with `meetings.export` pulls the raw bytes.
  //   meeting_insights.attachment_text_viewed  { feed_slug, message_id,
  //                                              attachment_id,
  //                                              extraction_status, mime }
  //     — fires when the AttachmentBlock UI expands to read parsed text.
  | "meeting_insights.attachment_downloaded"
  | "meeting_insights.attachment_text_viewed"
  // Phase 4 — calendar-event meeting brief.
  //   meeting_insights.brief_viewed: server-side per /api/meetings/brief
  //     hit. metadata = { title, matched: boolean, feed_slug,
  //                       open_action_items, recurring_topics,
  //                       exception_count }
  //   calendar.meeting_brief_opened: client-side disclosure click
  //     metadata = { event_id }
  //   calendar.meeting_brief_viewed: client-side after brief renders
  //     metadata = { event_id, matched, feed_slug }
  | "meeting_insights.brief_viewed"
  | "calendar.meeting_brief_opened"
  | "calendar.meeting_brief_viewed"
  // Phase 5 — ad-hoc multi-term analyze.
  //   meeting_insights.analyze_run: server-side per /api/meetings/analyze
  //     hit. metadata = { matched, analyzed, feeds_touched,
  //                       subject_filter_count, sender_filter_count,
  //                       since, until }
  | "meeting_insights.analyze_run"
  // MS 365 Insights panel — patterns computed from calendar + tasks + email.
  // `ms_insight.computed` fires server-side per request; `_viewed` /
  // `_cta_clicked` fire client-side so the learning loop can grade which
  // patterns the user actually engages with.
  | "ms_insight.computed"
  | "ms_insight.viewed"
  | "ms_insight.cta_clicked"
  // Weekly review + slip detector (Mon-Sun retrospective tile with
  // meeting load, task churn, email volume, goal-progress delta;
  // slip detector surfaces tasks carried forward 3+ days).
  | "review.weekly_computed"
  | "review.weekly_viewed"
  | "review.slip_detected"
  | "review.slip_resolved"
  // Feature requests
  | "feature.request_submitted"
  | "feature.request_write_failed"
  | "feature.request_analyzed"
  | "feature.request_approved"
  | "feature.request_rejected"
  | "feature.cost_estimated"
  // Features board — owner/admin CRUD (PUT + DELETE on /api/features/[id]).
  // Distinct from `feature.request_submitted` (initial POST); edits and
  // deletes fire as separate namespaces so the learning loop can grade
  // which features attract churn vs. get abandoned.
  | "features.edited"
  | "features.deleted"
  // Discussions
  | "discussion.thread_created"
  | "discussion.reply_posted"
  | "discussion.resolved"
  | "discussion.doc_attached"
  // Discussions — edit/delete (thread + comment). Fires on every mutation
  // so the learning loop sees churn rate per discussion + per author.
  //   discussions.discussion.edited   { discussion_id }
  //   discussions.discussion.deleted  { discussion_id }
  //   discussions.comment.edited      { reply_id, discussion_id }
  //   discussions.comment.deleted     { reply_id, discussion_id }
  | "discussions.discussion.edited"
  | "discussions.discussion.deleted"
  | "discussions.comment.edited"
  | "discussions.comment.deleted"
  // Discussions — offline queueing (Stream U2 templated offline rollout).
  // Fired ONLY on the queue path: navigator.onLine===false, or an inline
  // POST that returned non-ok / threw mid-flight. Inline 2xx writes keep
  // firing the existing server-side `discussion.thread_created` /
  // `discussion.reply_posted` events. On reconnect the queue drains and
  // emits `offline.mutation_replayed` / `offline.mutation_replay_failed`
  // from offline-queue itself — no new replay-side events needed.
  | "discussion.reply_queued_offline"
  | "discussion.thread_queued_offline"
  // Fires when the thread creator opts into "Notify all Wolfpack team members"
  // and the server finishes fanning notifications out to instinct_team_members.
  // Metadata: { discussion_id, recipient_count }. Skipped rows (dedup, errors)
  // are not subtracted; the count is the number of active team members the
  // fanout was attempted against.
  | "discussions.notify_all_fanout"
  // Prototypes
  | "prototype.created"
  | "prototype.deployed"
  | "prototype.shared"
  | "prototype.archived"
  // Client
  | "client.doc_generated"
  | "client.email_drafted"
  | "client.proposal_created"
  // Client records — owner/admin CRUD (PUT + DELETE on /api/clients/[id]).
  // Split out so analytics dashboards can slice "sales churn on client
  // records" independently from doc/email activity.
  | "clients.edited"
  | "clients.deleted"
  // System
  | "system.login"
  | "system.page_viewed"
  | "system.ai_call_made"
  | "system.ai_call_skipped"
  | "system.search_performed"
  | "system.analytics_queried"
  // Dashboard — personalized Quick Actions tile.
  //
  //   dashboard.quick_actions_rendered
  //     { source: "personalized" | "fallback", action_count }
  //     — fired once on mount when the Quick Actions card hydrates so
  //       the learning loop knows which users got personalized vs. the
  //       static cold-start list.
  //
  //   dashboard.quick_action_clicked
  //     { href, position, source: "personalized" | "fallback" }
  //     — fired when a tile is clicked. Click-through rate per
  //       personalized recommendation closes the loop on the half-life
  //       ranker: personalized rendered ÷ personalized clicked is the
  //       direct CTR signal we use to evaluate the algorithm.
  | "dashboard.quick_actions_rendered"
  | "dashboard.quick_action_clicked"
  // Assistant
  | "assistant.file_attached"
  | "assistant.doc_quality_checked"
  | "assistant.doc_rejected"
  | "assistant.doc_ingested"
  // Token-free intent router + tool-use pipeline.
  | "assistant.intent_classified"
  | "assistant.tool_invoked"
  | "assistant.fallback_to_rag"
  | "assistant.fallback_to_ai"
  // Related-pages chip + source chip click-through. Every response now
  // ships with `relatedPages[]` (domain → route map) and `sources[]`
  // (knowledge / brain / tool attributions). The two events below let
  // the learning loop grade which chips actually drive navigation vs.
  // which are cosmetic.
  //   assistant.link_clicked:   { domain }       — user clicked a
  //       "Related pages" chip that deep-links into /calendar etc.
  //   assistant.source_viewed:  { source_type }  — user expanded or
  //       clicked a source. `source_type` ∈
  //       {"knowledge","brain","tool","meeting","analytics"}.
  | "assistant.link_clicked"
  | "assistant.source_viewed"
  // Zero-token page-facts priority hit. Fires when the assistant answers
  // a "what is / how do I use <page>" question directly from the static
  // page-facts registry, before the knowledge base or RAG priorities
  // run. Metadata: { domain, confidence }. Lets the learning loop grade
  // which pages the team actually asks about and whether the bare-name
  // and verb-phrase heuristics fire with high confidence.
  | "assistant.page_facts_hit"
  // Floating FAB — user opened the bottom-right collapsed assistant
  // from any Instinct page. Metadata carries pathname so the learning
  // loop can see where users invoke the assistant most.
  //   assistant.floating_opened: { pathname }
  | "assistant.floating_opened"
  // Welcome tooltip on first dashboard visit — points users at the
  // floating FAB + the Knowledge Add-info flow. Three events form
  // the funnel so the learning loop can grade activation:
  //   welcome_tooltip.shown            — GET /me/welcome-tooltip → true
  //   welcome_tooltip.dismissed        — user closed without action
  //   welcome_tooltip.knowledge_clicked — user tapped the Knowledge CTA
  | "welcome_tooltip.shown"
  | "welcome_tooltip.dismissed"
  | "welcome_tooltip.knowledge_clicked"
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
  | "site.hard_deleted"
  | "site.repo_deleted"
  | "site.repo_delete_skipped"
  | "site.repo_delete_failed"
  | "site.vercel_project_deleted"
  | "site.vercel_project_delete_skipped"
  | "site.vercel_project_delete_failed"
  | "site.vercel_project_created"
  | "site.vercel_project_create_failed"
  | "site.repo_secret_set"
  | "site.repo_secret_failed"
  | "site.brief_auto_parsed"
  | "site.brief_parse_failed"
  | "site.brief_form_edited"
  | "site.dropzone_used"
  // Sites — custom domain binding (033_site_domains)
  | "site.domain_added"
  | "site.domain_verified"
  | "site.domain_removed"
  | "site.domain_add_failed"
  // Sites — unauthenticated share links + client approval workflow
  // (035_share_and_approvals). `token_nonce` is the UUID stored in
  // instinct_share_tokens — never the signed blob, never the secret.
  | "site.share_link_issued"
  | "site.share_link_accessed"
  | "site.share_link_revoked"
  | "site.approval_recorded"
  | "site.changes_requested"
  | "site.approval_expired"
  // Sites — PUBLIC contact-form submissions (034_site_form_submissions).
  // Metadata NEVER contains the recipient email in plaintext; we emit a
  // boolean `had_recipient` + the reason codes only.
  | "site.form_submitted"
  | "site.form_rejected"
  | "site.form_email_sent"
  | "site.form_email_failed"
  // Sites — image-wireframe → brief generator (031)
  | "site.brief_generation_requested"
  | "site.brief_generation_succeeded"
  | "site.brief_generation_failed"
  | "site.brief_image_rejected"
  // Sites — exemplar retrieval primer (reads accepted generations per client)
  | "site.brief_exemplars_served"
  | "site.brief_exemplars_empty"
  // Sites — multi-frame wireframe upload (033)
  | "site.brief_upload_frames_added"
  | "site.brief_upload_frame_removed"
  | "site.brief_upload_reordered"
  | "site.brief_multi_frame_requested"
  | "site.brief_multi_frame_rejected"
  // Sites — starter-template picker (031)
  | "site.template_previewed"
  | "site.template_applied"
  // Sites — video section added via BriefForm (YouTube/Vimeo embeds)
  | "site.section_video_added"
  // Sites — sales/conversion sections added via BriefForm
  | "site.section_testimonial_added"
  | "site.section_pricing_added"
  | "site.section_faq_added"
  // Sites — brand theme edited via ThemeEditor (colors + font picker)
  | "site.theme_edited"
  // Sites — per-page SEO edits + favicon generation. Metadata includes
  // site_id, page_index (or -1 for defaultSeo / site-level favicon),
  // and fields_changed[] so the learning loop can tell which SEO fields
  // designers touch most. `site.favicon_generated` metadata.mode is one
  // of "url" | "auto" | "monogram".
  | "site.seo_updated"
  | "site.favicon_generated"
  // Sites — prompt-to-brief editor (029)
  | "site.brief_edit_requested"
  | "site.brief_edit_generated"
  | "site.brief_edit_failed"
  | "site.brief_edit_blocked"
  | "site.brief_edit_decided"
  // Sites — brief-edit learning loop (030)
  | "site.insights_viewed"
  | "site.insights_snapshot_taken"
  // Sites — AI image generation inside BriefForm (032)
  | "site.image_gen_opened"
  | "site.image_gen_submitted"
  | "site.image_gen_succeeded"
  | "site.image_gen_failed"
  | "site.image_gen_accepted"
  | "site.image_gen_regenerated"
  | "site.image_gen_dismissed"
  // People (HR) — benefits, employees, onboarding, insights
  | "hr.employee_added"
  // HR employee edit/delete — dotted namespace per the 2026-04 edit/delete
  // product launch. Paired with the legacy `hr.employee_updated` /
  // `hr.employee_removed` events for backwards compat.
  //   hr.employee.updated  { employee_id }
  //   hr.employee.deleted  { employee_id }
  | "hr.employee.updated"
  | "hr.employee.deleted"
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
  // HR insights — grouped view (2026-04-23). Alicia asked for the
  // compilation to be bucketed by category and collapsible, default
  // collapsed after the first group. Every load + expand fires so the
  // brain can learn which buckets get opened most.
  //   hr.insights.grouped_view  { group_count, insight_count }
  //   hr.insights.group_expanded { category, count }
  | "hr.insights.grouped_view"
  | "hr.insights.group_expanded"
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
  // Microsoft 365 Mail (Mail.Send + Mail.ReadWrite for inbox surface)
  | "system.ms_mail_sent"
  | "system.ms_mail_reply_sent"
  | "system.ms_mail_reply_all_sent"
  | "system.ms_mail_forward_sent"
  | "system.ms_mail_send_failed"
  | "system.ms_mail_read"
  | "system.ms_mail_listed"
  | "system.ms_mail_read_state_changed"
  | "system.ms_mail_archived"
  | "system.ms_mail_deleted"
  // /emails inbox surface — user-facing actions emitted via emitInsight().
  // The strings carry the `insight.email.<action>` prefix at the wire so
  // they group with the rest of the email surface in analytics queries,
  // but we also accept the bare `email.<action>` form when surfaces use
  // trackEvent directly. Keep both shapes typed so neither path widens to
  // string and silently drops events.
  | "insight.email.inbox_opened"
  | "insight.email.thread_read"
  | "insight.email.replied"
  | "insight.email.archived"
  | "insight.email.deleted"
  | "insight.email.compose_drawer_opened"
  | "insight.email.message_viewed"
  | "insight.email.reply_sent"
  | "insight.email.reply_failed"
  | "insight.email.compose_opened"
  | "insight.email.recipient_set"
  | "insight.email.template_inserted"
  | "insight.email.format_applied"
  | "insight.email.insights_loaded"
  | "insight.email.recipient_card_expanded"
  | "insight.email.layout_mode"
  | "insight.email.right_pane_state"
  | "insight.email.nav_rail_toggled"
  | "insight.email.recipient_context_toggled"
  | "insight.email.marked_unread"
  | "insight.email.forwarded"
  // Folder switching surface — Drafts / Sent / Archived feed the learning
  // loop's per-folder usage + load-latency views.
  | "insight.email.folder_changed"
  | "insight.email.folder_loaded"
  | "insight.email.draft_opened_in_composer"
  | "insight.email.draft_clicked_skipped"
  // Unsaved-draft dialog (replaces window.confirm). The "shown" event
  // fires once per dialog open; the "resolved" event fires once when
  // the user picks an action. shown_for_ms feeds the learning loop —
  // long hesitation = the draft-detection heuristic likely too aggressive.
  | "insight.email.unsaved_draft_dialog_shown"
  | "insight.email.unsaved_draft_dialog_resolved"
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
  | "tools.page_viewed"
  // E2E reality-check suite (browser-level parity + upload + designer journey)
  // Every Playwright reality-check run posts this so the learning loop can
  // track which specs flap, which catch regressions, and which never fail —
  // a signal for trustworthy vs "green but uninformative" test coverage.
  | "e2e.reality_check_ran"
  // Sites — direct-manipulation (Path C Phase 1)
  | "site.viewport_changed"
  // Sites — direct-manipulation (Path C Phase 1, Stream P2)
  // Designers click any heading/body/CTA label inside the preview iframe,
  // edit inline, and the brief state updates live. These events feed the
  // learning loop with signals on:
  //   - which section types + fields designers touch most (copy-quality gap)
  //   - inline_text_edited.char_delta — whether designers shorten or
  //     expand AI-generated copy (model-tuning signal for brief-edit LLM)
  //   - preview_hovered — which sections designers inspect without editing
  //     (hover-only = "close enough"; edit = "model was off")
  | "site.inline_text_edited"
  | "site.inline_cta_edited"
  | "site.preview_hovered"
  // Sites — asset library (Path C Phase 1, Stream P3)
  // Per-client ASSET LIBRARY — logo / hero photo / product shot uploaded
  // once per client and reusable across every site. Metadata shape:
  //   client_asset_uploaded: { client_slug, kind, size_bytes, deduped }
  //     — `deduped: true` when the sha256 already existed for this client,
  //       so we bumped use_count instead of inserting a duplicate row.
  //   client_asset_reused:   { client_slug, asset_id, site_id, kind }
  //     — fires on recordAssetUsage. Reuse rate is THE key KPI for the
  //       library's value; the learning loop scores clients by how often
  //       existing assets get picked instead of re-uploaded.
  //   client_asset_deleted:  { client_slug, asset_id }
  | "client_asset_uploaded"
  | "client_asset_reused"
  | "client_asset_deleted"
  // Sites — design tokens (Path C Phase 1, Stream P4)
  // Designers edit spacing / radius / type-scale / motion / font-stack
  // tokens via the ThemeEditor. Metadata shape:
  //   site.design_token_applied:     { site_id, token_group, token_name,
  //                                    new_value }
  //     — `token_group` ∈ {"spacing","radius","typeScale","motion","font"}
  //       `token_name`  is the tier key (e.g. "md", "2xl", "weightBold")
  //       `new_value`   is the string (or stringified number) the designer
  //                     entered. For typeScale entries the name is
  //                     "<tier>.fontSize" or "<tier>.lineHeight".
  //   site.theme_token_defaults_applied: { site_id }
  //     — fires exactly once per brief when token scales are first seeded
  //       from DEFAULT_*, marking the brief as "designer-aware."
  //
  // Learning-loop note: diff between edited tokens and defaults is the
  // signal the brain distills per client. Exemplar extraction surfaces
  // the most-common override patterns to the next brief generation.
  | "site.design_token_applied"
  | "site.theme_token_defaults_applied"
  // Sites — direct-manipulation (Path C Phase 2)
  // Designers drag a section's handle inside the preview iframe (or press
  // ArrowUp/Down on the focused handle) to reorder the brief's sections
  // live. Metadata shape:
  //   { site_id, page_index, section_type_moved, from_index, to_index,
  //     move_distance }
  // where `move_distance = to_index - from_index` (signed). The learning
  // loop aggregates per client+section_type_moved to detect patterns like
  // "designers always move testimonial before pricing" → the exemplar
  // layer surfaces those so the next brief extraction proposes the common
  // order automatically (zero-token ordering improvements).
  | "site.section_reordered"
  // Sites — brand URL import (Path C Phase 2)
  // Designer pastes a client's existing website URL; Instinct scrapes
  // its palette/fonts/logo and maps them into a SiteTheme suggestion
  // that can seed a new SiteBrief. Metadata:
  //   brand_import_requested: { url_host }
  //     — host-only, no full URL (no query PII).
  //   brand_import_completed: { url_host, palette_size, font_count,
  //                             latency_ms, had_og_image }
  //   brand_import_failed:    { url_host, reason }
  //     — `reason` ∈ BrandImportReason except "ok".
  //   brand_import_applied:   { site_id, url_host, applied_fields }
  //     — KPI for the feature: which scraped tokens do designers
  //       actually accept? `applied_fields` is a joined-string list
  //       (comma-delimited) of the theme paths the UI wrote back.
  | "brand_import_requested"
  | "brand_import_completed"
  | "brand_import_failed"
  | "brand_import_applied"
  // Sites — Figma import (Path C Phase 3)
  // Designer pastes a Figma file URL; Instinct calls the Figma REST API
  // and produces a structured SiteBrief suggestion — theme tokens plus
  // frame-to-section mapping. Higher fidelity than the HTML scraper
  // because it reads the designer's actual layers. Metadata:
  //   figma_import_requested: { file_key }
  //     — file key only, never the full URL (URLs can contain team /
  //       node / branch query params that aren't analytics-relevant).
  //   figma_import_completed: { file_key, frame_count, color_count,
  //                             font_count, latency_ms }
  //   figma_import_failed:    { file_key, reason }
  //     — `reason` ∈ FigmaImportReason except "ok".
  //   figma_import_applied:   { site_id, file_key, applied_pages_count,
  //                             applied_theme_fields }
  //     — KPI for the feature: acceptance rate of the Figma-derived
  //       suggestion. The exemplar layer distills per-client patterns
  //       (e.g. "on this client the primary palette always keeps the
  //       top-2 colors, not all 4") for the next import.
  | "figma_import_requested"
  | "figma_import_completed"
  | "figma_import_failed"
  | "figma_import_applied"
  // Sites — version history (Path C Phase 3)
  // Unified timeline over instinct_site_brief_generations +
  // instinct_site_brief_edits. Restore is the strong signal: clients whose
  // designers roll back often = brittle edit / extraction patterns that
  // the learning loop flags for tuning.
  //   site.version_history_viewed: { site_id, version_count }
  //   site.version_diff_viewed:    { site_id, version_id, field_changes }
  //     — field count so the learning loop can distill typical diff
  //       sizes per client
  //   site.version_restored:       { site_id, from_version_id,
  //                                  to_version_id, field_changes }
  //     — restore is a strong signal that something went wrong; the
  //       learning loop uses this to flag brittle edit patterns
  | "site.version_history_viewed"
  | "site.version_diff_viewed"
  | "site.version_restored"
  // Sites — editor-vs-live parity diagnostic. Fired by the editor detail
  // page right after the preview iframe mounts with both a deployed URL
  // and an in-memory draft, so the learning loop can track how often
  // designers are likely seeing a drift between the two surfaces.
  //   sites.editor_preview_parity_check: { site_id, source, has_preview_url }
  | "sites.editor_preview_parity_check"
  // Sites — section comments (Path C Phase 3 · Stream R3)
  //
  // Threaded per-section review comments. Two posting paths: unauth
  // share-link reviewers (via_share_token=true) and authed designers
  // (via_share_token=false). Metadata shapes:
  //
  //   site.comment_posted:   { site_id, via_share_token, page_index,
  //                            section_index, section_type, body_length,
  //                            has_actor_email }
  //     — body_length is the raw trimmed length; body itself is NEVER
  //       in analytics (client text may contain business PII).
  //
  //   site.comment_resolved: { site_id, comment_id, resolved_by_role }
  //     — resolve RATE (resolved ÷ posted per site) is THE KPI for this
  //       feature. A high rate = healthy client feedback loop. A low
  //       rate = comments are piling up unread, signal for the learning
  //       loop to flag the client relationship.
  //
  //   site.comment_replied:  { site_id, parent_comment_id }
  //     — thread depth tracking. Deep threads = nuanced feedback; shallow
  //       threads = quick single-shot comments.
  //
  //   site.comment_deleted:  { site_id, comment_id, deleted_by_role }
  //     — deletes are SOFT (body tombstoned in DB); the row survives so
  //       the audit trail stays intact. deleted_by_role tells ops
  //       whether client-side tools are deleting too aggressively.
  | "site.comment_posted"
  | "site.comment_resolved"
  | "site.comment_replied"
  | "site.comment_deleted"
  // Sites — direct-manipulation canvas (Path C Phase 4 · Stream U2)
  //
  // Designer toggles the canvas into direct-edit mode and drives section
  // and field changes by clicking directly on the preview — no prompt,
  // no sidebar. Each of the six events feeds the learning loop with a
  // distinct signal:
  //
  //   direct_edit.enabled / direct_edit.disabled
  //     — raw adoption signal; what % of edit sessions use direct-edit
  //       vs. prompt-only. Low adoption = discoverability problem on the
  //       toggle chrome; high adoption = we should invest in the flow.
  //   direct_edit.element_clicked (metadata: element_type)
  //     — which element types designers REACH for first. If everyone
  //       clicks headings but never CTAs, the CTA toolbar is buried.
  //   direct_edit.text_committed (metadata: section_id, field)
  //     — committed inline text edits. Feeds same learning loop as
  //       `site.inline_text_edited` but scoped to the canvas UX so we
  //       can compare prompt-driven vs direct-manipulation quality.
  //   direct_edit.cta_committed (metadata: section_id)
  //     — CTA label/href changes from the floating toolbar.
  //   direct_edit.section_reordered_via_canvas (metadata: from_idx, to_idx)
  //     — parallels `site.section_reordered` but distinguishes
  //       toolbar-arrow usage from drag-handle usage. Designer
  //       preference here drives future UX investment.
  | "direct_edit.enabled"
  | "direct_edit.disabled"
  | "direct_edit.element_clicked"
  | "direct_edit.text_committed"
  | "direct_edit.cta_committed"
  | "direct_edit.section_reordered_via_canvas"
  // Sites — offline mode (Path C — site editor resiliency). The editor
  // persists failed mutations to IndexedDB and replays on reconnect.
  // Metadata shapes:
  //   offline.detected:                  {}
  //     — fires once when navigator goes offline with editor open.
  //   offline.returned_online:           { queue_size }
  //     — fires at the top of flushQueue so we see inbound-replay
  //       burst size per user session.
  //   offline.mutation_queued:           { endpoint, method }
  //   offline.mutation_replayed:         { endpoint, success }
  //   offline.mutation_replay_failed:    { endpoint, error, attempt }
  //     — retry counter so the learning loop can see which endpoints
  //       are flaky vs. which are terminal (auth, validation).
  //   offline.brief_served_from_cache:   { site_id, cache_age_ms }
  //     — cold-load from cache actually unblocked a designer (KPI).
  //   offline.resource_served_from_cache:
  //     { resource_type, resource_id, cache_age_ms }
  //     — Stream U4 generalization of brief_served_from_cache. Fires
  //       for every feature that uses offline-cache.ts (brief,
  //       meeting_draft, hr_doc_pending, journal_entry, ...). The
  //       `resource_type` metadata lets the analytics dashboard slice
  //       offline usage per feature area. For backward compat the
  //       brief cache still ALSO fires offline.brief_served_from_cache
  //       when resource_type === "brief".
  // PWA install signals:
  //   pwa.install_prompt_shown:          {}
  //   pwa.install_prompt_dismissed:      { outcome }  "accepted"|"dismissed"
  //   pwa.installed:                     {}
  | "offline.detected"
  | "offline.returned_online"
  | "offline.mutation_queued"
  | "offline.mutation_replayed"
  | "offline.mutation_replay_failed"
  | "offline.brief_served_from_cache"
  | "offline.resource_served_from_cache"
  // RAG offline cache (Path C — Stream U5)
  //
  // Reusable primitive sitting on top of offline-cache.ts that stashes
  // RAG query+answer+sources snapshots so assistant / brain / knowledge
  // flows survive a cold-load while the user is offline. Keys by
  // normalized query fingerprint; falls back to Jaccard fuzzy match on
  // the tokenized query when no exact hit exists. Metadata shapes:
  //
  //   rag.result_cached       { scope, query_token_count, doc_count }
  //     — `scope` is the RAG sub-scope ("assistant" | "brain" |
  //       "knowledge" | caller-defined string). `query_token_count` is
  //       post-stopword-strip so the learning loop can see how much
  //       signal the query carried. `doc_count` is retrieved_docs.length
  //       so we can distill per-scope the typical breadth of a hit.
  //
  //   rag.served_from_cache   { scope, similarity, is_fuzzy,
  //                             cache_age_ms }
  //     — fires on cache hit (exact OR fuzzy). `similarity` ∈ [0,1],
  //       Jaccard on tokens. `is_fuzzy=false` implies similarity===1.
  //       The learning loop watches `is_fuzzy` rate — too many fuzzy
  //       hits means the fingerprint is underspecified (stopword list
  //       may need trimming) or the scope has too few cached queries.
  //
  //   rag.cache_miss_offline  { scope }
  //     — offline read path found no cached match (exact or fuzzy).
  //       The user is about to see an empty RAG state; this is the
  //       clearest signal of a coverage gap for that scope.
  //
  //   rag.cache_evicted       { scope, count }
  //     — fires on every eviction sweep. `count` is the number of rows
  //       dropped. High frequency here = the per-scope cap is too
  //       aggressive for the traffic pattern.
  | "rag.result_cached"
  | "rag.served_from_cache"
  | "rag.cache_miss_offline"
  | "rag.cache_evicted"
  // RAG ambient doc-body backfill (Path C — Stream U5 follow-up).
  //
  // When any of the 3 RAG wrappers (assistant / brain / knowledge)
  // successfully caches a fresh online response, we silently fire
  // background fetches for the top-K source doc bodies and stash them
  // in the generic resource cache under resource_type="doc_body" so
  // that if the user taps a source offline we can show the full text.
  // This is pure infrastructure — no UI surface. The four events below
  // let the learning loop see how often backfill runs, how much it
  // hydrates, and where it has coverage gaps.
  //
  //   rag.doc_backfill_scheduled { scope, source_count, top_k }
  //     — scheduleDocBodyBackfill() was invoked by a wrapper. Fires
  //       ONCE per wrapper success, BEFORE any network work starts.
  //       source_count = raw sources length, top_k = how many we will
  //       actually attempt after truncation.
  //
  //   rag.doc_backfilled { scope, doc_id, bytes }
  //     — one doc body was fetched + cached successfully. `bytes` is
  //       approx byte length of the cached `content` string so the
  //       learning loop can detect pathological payloads.
  //
  //   rag.doc_backfill_skipped { scope, doc_id, reason }
  //     — one doc body fetch was skipped or failed. `reason` ∈
  //       { "recent_cache_hit" | "no_endpoint" | "fetch_failed"
  //         | "timeout" }. High `no_endpoint` rates on a scope mean we
  //       should ship a doc-body route for that scope.
  //
  //   rag.doc_backfill_completed { scope, attempted, cached, skipped,
  //                                 failed, duration_ms }
  //     — fires when a single scheduled backfill batch finishes. Useful
  //       for measuring actual hydration rate: cached / attempted.
  | "rag.doc_backfill_scheduled"
  | "rag.doc_backfilled"
  | "rag.doc_backfill_skipped"
  | "rag.doc_backfill_completed"
  // Ambient RAG refresh (Path C · Stream U6). Silent re-touch of cached
  // queries on session-start and during idle to keep cached_at fresh
  // ahead of offline moments. Emitted from `src/lib/ambient-refresh.ts`.
  //
  //   ambient.warm_pass_started     { scope_count }
  //     — fired once at the start of each runSessionWarmPass(). scope_count
  //       is the number of scopes the pass will iterate (currently 3).
  //
  //   ambient.warm_pass_completed   { scope, attempted, refreshed, failed,
  //                                   duration_ms }
  //     — one per scope once that scope's iteration finishes (or is
  //       aborted). attempted/refreshed/failed let dashboards surface how
  //       effective the pass is per scope so we can tune topN + delay.
  //
  //   ambient.idle_detected         { idle_ms }
  //     — the user has been idle for idle_ms (≥ idleThresholdMs). Fires
  //       every time the idle watcher ticks; high frequency + low
  //       refresh rate suggests the user lingers but doesn't interact.
  //
  //   ambient.idle_refresh_fired    { scope, cache_age_ms_before,
  //                                   cache_age_ms_after }
  //     — a stalest-entry refresh succeeded. cache_age_ms_after is the
  //       age right after the refresh write (typically 0).
  //
  //   ambient.idle_refresh_skipped  { reason }
  //     — idle refresh was deliberately suppressed. reason ∈
  //       {"offline","save_data","no_stale_entries","max_refreshes_reached"}
  //       — lets us slice by cause (bandwidth preference vs cap vs
  //       nothing stale) when looking at refresh-churn telemetry.
  | "ambient.warm_pass_started"
  | "ambient.warm_pass_completed"
  | "ambient.idle_detected"
  | "ambient.idle_refresh_fired"
  | "ambient.idle_refresh_skipped"
  | "pwa.install_prompt_shown"
  | "pwa.install_prompt_dismissed"
  | "pwa.installed"
  // Sites — unified studio shell (Path C Phase 4 · Stream U1)
  //
  // The /sites/[id] page is the unified studio (formerly split across
  // /sites/[id] + /sites/[id]/edit). Framer/Webflow-style 3-pane
  // layout: left TabDock (Chat / Sections / Theme / Assets / SEO /
  // Forms / Domain / Share / Versions / Comments), center preview
  // iframe, right Inspector. Every interaction feeds the learning
  // loop so we can surface "designers who open the Sections tab
  // first publish 2x faster" style patterns.
  //
  //   studio.opened:                  { site_id }
  //   studio.tab_changed:             { site_id, tab_name }
  //     — tab_name ∈ {"chat","sections","theme","assets","seo","forms",
  //                   "domain","share","versions","comments"}
  //   studio.section_selected:        { site_id, section_id }
  //     — section_id is "<index>:<type>" so analytics queries can
  //       group by section type without requiring a join to the brief.
  //   studio.section_reordered:       { site_id, from_idx, to_idx }
  //   studio.section_duplicated:      { site_id, section_id }
  //   studio.section_deleted:         { site_id, section_id }
  //   studio.section_added:           { site_id, section_type }
  //   studio.inspector_field_edited:  { site_id, field_path, section_id }
  //     — field_path is slash-delimited (e.g. "heading", "cta/label").
  //   studio.publish_clicked:         { site_id, pending_edit_count }
  //     — publish was clicked; server-side save+deploy runs separately.
  | "studio.opened"
  | "studio.tab_changed"
  | "studio.section_selected"
  | "studio.section_reordered"
  | "studio.section_duplicated"
  | "studio.section_deleted"
  | "studio.section_added"
  | "studio.inspector_field_edited"
  | "studio.publish_clicked"
  // RAG provider abstraction — vector/graph/embedding telemetry.
  //
  // Every event is fired fire-and-forget by the provider-abstraction
  // layer (`src/lib/rag-providers/*`). These feed the learning loop so
  // the ML pipeline can learn from every RAG operation and every
  // divergence between stores during the Azure migration.
  //
  //   rag.vector_provider_selected    { provider }
  //     — boot-time: which vector backend the factory resolved to.
  //   rag.vector_upsert_ok / failed   { target, side, written?, error? }
  //   rag.vector_query_ok  / failed   { target, side, hits?, error? }
  //   rag.vector_delete_ok / failed   { target, deleted?, error? }
  //   rag.vector_health_ok / failed   { target, latency_ms, detail? }
  //   rag.embedding_ok     / failed   { provider, model, dims?, error? }
  //   rag.graph_upsert_ok  / failed   { target, node_id, error? }
  //   rag.graph_query_ok   / failed   { target, rows?, error? }
  //   rag.graph_health_ok  / failed   { target, latency_ms, detail? }
  //   rag.dual_write_started          { primary, secondary, mode, docs }
  //   rag.dual_write_completed        { primary, secondary, mode,
  //                                      primary_written, secondary_written,
  //                                      divergence }
  //   rag.dual_write_failed           { target, side, error, mode }
  //   rag.dual_write_divergence       { primary, secondary,
  //                                      primary_written, secondary_written,
  //                                      mode }
  //   rag.dual_read_divergence        { primary, secondary, primary_ids,
  //                                      secondary_ids, intersection,
  //                                      primary_only, secondary_only }
  //   rag.provider_fallback_triggered { from, to, reason }
  | "rag.vector_provider_selected"
  | "rag.vector_upsert_ok"
  | "rag.vector_upsert_failed"
  | "rag.vector_query_ok"
  | "rag.vector_query_failed"
  | "rag.vector_delete_ok"
  | "rag.vector_delete_failed"
  | "rag.vector_health_ok"
  | "rag.vector_health_failed"
  | "rag.embedding_ok"
  | "rag.embedding_failed"
  | "rag.graph_upsert_ok"
  | "rag.graph_upsert_failed"
  | "rag.graph_query_ok"
  | "rag.graph_query_failed"
  | "rag.graph_health_ok"
  | "rag.graph_health_failed"
  | "rag.dual_write_started"
  | "rag.dual_write_completed"
  | "rag.dual_write_failed"
  | "rag.dual_write_divergence"
  | "rag.dual_read_divergence"
  | "rag.provider_fallback_triggered"
  // MS Teams chat / presence / deep-link integration (Phase 1 — read-only).
  //
  //   ms_chats.listed              { count }
  //     — `/me/chats` returned `count` chats.
  //   ms_chats.messages_loaded     { chat_id, count }
  //     — `/me/chats/{id}/messages` returned `count` messages.
  //   ms_chats.scope_missing       {}
  //     — Graph returned 401/403 for chats; caller should prompt re-consent
  //       for `Chat.Read`.
  //   ms_presence.batch_fetched    { count }
  //     — batched `/me/presences` or per-user presence fetch resolved
  //       `count` user presences.
  //   ms_presence.scope_missing    {}
  //     — Graph returned 401/403 for presence; caller should prompt
  //       re-consent for `Presence.Read`.
  //   ms_deep_link.generated       { type }
  //     — a Teams deep-link URL was generated. `type` ∈
  //       "chat" | "call" | "meet_now".
  //   ms_chats.message_sent        { chat_id, length }
  //     — inline compose succeeded against `/me/chats/{id}/messages`.
  //       `length` is the final body character count POSTed (post-
  //       sanitization). Fired from the server-side lib on Graph 201.
  //   ms_chats.write_disabled      { user_id }
  //     — POST /api/ms/chats/[id]/messages rejected because the
  //       INSTINCT_TEAMS_WRITE_ENABLED env flag is off (compliance-light
  //       client deployment). No Graph call was made.
  | "ms_chats.listed"
  | "ms_chats.messages_loaded"
  | "ms_chats.scope_missing"
  | "ms_chats.message_sent"
  | "ms_chats.write_disabled"
  | "ms_presence.batch_fetched"
  | "ms_presence.scope_missing"
  | "ms_deep_link.generated"
  // Messages inline-compose (Phase 1.5 — Teams write path).
  //
  // The /messages page now hosts an inline composer that POSTs to
  // /api/ms/chats/[id]/messages instead of punting every user to the
  // Teams desktop client via deep-link. These events let the learning
  // loop grade inline-compose adoption, failure mode distribution, and
  // permission-gate friction.
  //
  //   messages.compose_sent          { chat_id, length }
  //     — fires on a 200 server response. `length` is the trimmed body
  //       length so the brain can distil typical message size per user
  //       / per chat without storing the body itself (privacy).
  //
  //   messages.compose_failed        { chat_id, reason }
  //     — every non-success path. `reason` ∈ {"scope_missing",
  //       "write_disabled","network","http_<status>"}. Distinct from
  //       compose_sent so the failure rate is trivially computable.
  //
  //   messages.scope_prompt_shown    { chat_id }
  //     — the inline "Grant Chat.ReadWrite to send from here" hint was
  //       surfaced. Fires once per render of the prompt. High rate ⇒
  //       too many users have Read-only scope; nudge the settings flow.
  //
  //   messages.write_disabled_shown  { chat_id }
  //     — the workspace flag `inline_teams_write` is off. Fires when
  //       the inline hint surfaces pointing users at the Reply-in-Teams
  //       deep-link. High rate ⇒ a workspace owner disabled the flag;
  //       lets Agent A's flag roll-out track churn.
  | "messages.compose_sent"
  | "messages.compose_failed"
  | "messages.scope_prompt_shown"
  | "messages.write_disabled_shown"
  // Cross-page Teams unread badge (top-nav) — lets the learning loop
  // size how often the badge polls, how often users engage with it,
  // and how "fresh" Teams activity maps to user attention.
  //
  //   messages.unread_count_polled   { count }
  //     — fires server-side on every GET /api/ms/chats/unread-count
  //       that resolves (including scope_missing and not-connected
  //       paths). `count` is the number of chats newer than the
  //       client-provided `since` timestamp; 0 when absent or none.
  //
  //   messages.unread_badge_clicked  { count }
  //     — fires client-side when the user clicks the badge to jump to
  //       /messages. `count` is the value shown at click time so we
  //       can distinguish "zero-badge tap" (shouldn't happen, badge is
  //       hidden) from "dismissed N unread".
  | "messages.unread_count_polled"
  | "messages.unread_badge_clicked"
  // /messages left-panel structure — collapsible Chats section + new
  // Teams-and-channels section. Lets the learning loop see which
  // surface users actually use, and which teams/channels are hot.
  //
  //   messages.section_toggled   { section, expanded }
  //     section ∈ "chats" | "teams"
  //     expanded: true when opening, false when collapsing
  //
  //   messages.team_toggled      { team_id, expanded }
  //     fires when a user clicks the chevron next to a team to
  //     reveal/hide its channels list.
  //
  //   messages.channel_selected  { team_id, channel_id }
  //     fires when a user clicks a channel row to load its messages.
  | "messages.section_toggled"
  | "messages.team_toggled"
  | "messages.channel_selected"
  // Server-side Graph proxy for the Teams-and-channels surface.
  // Mirror of the ms_chats.* family so the learning loop can size
  // Graph quota and detect scope drops symmetrically.
  //
  //   ms_teams.listed                    { count }
  //   ms_teams.channels_listed           { team_id, count }
  //   ms_teams.channel_messages_loaded   { team_id, channel_id, count }
  //   ms_teams.scope_missing             { surface, team_id?, channel_id? }
  | "ms_teams.listed"
  | "ms_teams.channels_listed"
  | "ms_teams.channel_messages_loaded"
  | "ms_teams.channel_message_sent"
  | "ms_teams.scope_missing"
  | "messages.channel_compose_sent"
  | "messages.channel_compose_failed"
  // AI smart-compose / draft-reply — fires across chat, channel, and
  // email composers. The acceptance/modification rate per surface is
  // a high-quality training signal: it tells us where AI drafts land
  // closest to what the user actually sends, and where they're so
  // off the user starts from scratch.
  //
  //   assistant.draft_requested   { surface, context_id?, had_draft_so_far,
  //                                 thread_turns, model, prompt_tokens,
  //                                 completion_tokens }
  //   assistant.draft_accepted    { surface, context_id?, edit_distance,
  //                                 sent_length }   — fires on send if
  //                                 user sent within 5min of the draft
  //   assistant.draft_modified    { surface, context_id?, edit_distance,
  //                                 sent_length }   — fires when sent text
  //                                 differs significantly from draft
  //   assistant.draft_discarded   { surface, context_id? }
  //                                 — fires when user clears the draft
  //                                 without sending
  //   assistant.draft_failed      { surface, reason }
  | "assistant.draft_requested"
  | "assistant.draft_accepted"
  | "assistant.draft_modified"
  | "assistant.draft_discarded"
  | "assistant.draft_failed"
  // @mentions inside chat composer. Mention-then-action correlation
  // (was the @mentioned user's reply within N min?) is one of the
  // best "team responsiveness" signals in the warehouse.
  //
  //   ms_chats.mentions_sent       { chat_id, mention_count }
  //   messages.mention_added       { chat_id, target_user_id }
  //   messages.mention_completed   { chat_id, mention_count }
  //     — fires on send when message contained at least one mention
  | "ms_chats.mentions_sent"
  | "messages.mention_added"
  | "messages.mention_completed"
  // Automations — modular workflow surface. Stream A (porsche-classes)
  // is the first concrete automation. Every meaningful ingest and human
  // intervention emits one of these so the learning loop can see how
  // many manual overrides land per artifact, which automations have the
  // worst parse precision, and which exception kinds pile up unactioned.
  //
  //   automations.artifact_ingested   { automation_id, source_type,
  //                                      source_message_id, classes }
  //     — fires after a successful parse + persist. `classes` is the
  //       count of distinct class_keys observed in this artifact.
  //
  //   automations.artifact_quarantined { automation_id, source_message_id,
  //                                        reason, exception_kind }
  //     — fires when a parser returns ParseFailure; the artifact moves
  //       to error_quarantined and an exception row is created.
  //
  //   automations.delta_computed       { automation_id, class_key,
  //                                        added, dropped, is_baseline }
  //     — fires on every delta row insert (including baselines).
  //
  //   automations.override_applied     { automation_id, kind }
  //     — fires when Alicia (or a teammate) records a manual override.
  //
  //   automations.exception_resolved   { automation_id, kind,
  //                                        outcome }   outcome=resolved|dismissed
  //
  //   automations.poll_run             { automation_id, new_artifacts,
  //                                        duration_ms }
  //     — one inbox-poller cycle finished; new_artifacts is how many
  //       fresh items were ingested this tick.
  | "automations.artifact_ingested"
  | "automations.artifact_quarantined"
  | "automations.delta_computed"
  | "automations.override_applied"
  | "automations.exception_resolved"
  | "automations.poll_run"
  | "automations.poll_historical"
  | "automations.poll_skipped"
  //
  //   automations.cursor_advanced     { automation_id, mailbox_base,
  //                                      cursor_kind, ms_since_last_poll }
  //     — fires every time the inbox poller writes a new cursor for
  //       (automation_id, user_id, mailbox_base). cursor_kind is
  //       "delta" | "search" so the learning loop can tell which Graph
  //       access mode is running. ms_since_last_poll is the elapsed time
  //       since the previous successful cursor write for THIS mailbox
  //       base (null on first write); over time the system can detect a
  //       stalled mailbox by watching this drift past the cron interval.
  //       Empty mailbox_base ('') represents the legacy default mailbox.
  | "automations.cursor_advanced"
  // Meeting Insights — multi-feed recurring-meeting ingest (Stream A).
  //
  //   automations.feed_created      { automation_id, feed_id, feed_slug,
  //                                    sender_match_count, subject_match_count }
  //     — admin created a new feed; the sender/subject counts let
  //       dashboards spot pathological catch-all feeds early.
  //
  //   automations.feed_updated      { automation_id, feed_id, feed_slug,
  //                                    fields }   fields=comma-joined
  //     — any patch to name / description / filters / is_enabled.
  //
  //   automations.feed_disabled     { automation_id, feed_id, feed_slug }
  //     — soft-delete (is_enabled=false). History is preserved.
  //
  //   automations.feed_poll_triggered { automation_id, feed_id, feed_slug,
  //                                     messages_seen, messages_matched,
  //                                     artifacts_ingested, errors }
  //     — operator hit the "Run now" button on a feed. The poll under
  //       the hood is still automation-wide (one Graph cursor) but the
  //       event records which feed asked.
  | "automations.feed_created"
  | "automations.feed_updated"
  | "automations.feed_disabled"
  | "automations.feed_poll_triggered"
  // Meeting Insights — Phase 2 analyzer + Phase 3 themes events.
  //
  //   automations.message_analyzed   { automation_id, feed_id, feed_slug,
  //                                     message_id, analyzer_version,
  //                                     status, topics, decisions,
  //                                     action_items, tokens_used,
  //                                     triggered_by? }
  //     — fired after every analyzer pass (success | partial | error).
  //       triggered_by="manual" when the operator hit "Re-analyze".
  //
  //   automations.message_reanalyze_requested { automation_id, feed_id,
  //                                              feed_slug, message_id,
  //                                              prior_status }
  //     — operator clicked "Re-analyze" on a message detail page.
  //
  //   automations.themes_viewed     { automation_id, feed_id, feed_slug,
  //                                    recurring, stale, open_action_items }
  //     — themes tab page-view; counts so we can see whether the page
  //       is actually surfacing signal.
  //
  //   automations.themes_searched   { automation_id, feed_id, feed_slug,
  //                                    query_length, hit_count }
  //     — semantic search executed. query_length only (no q text) so
  //       we don't leak meeting content into the events stream.
  | "automations.message_analyzed"
  | "automations.message_reanalyze_requested"
  | "automations.themes_viewed"
  | "automations.themes_searched"
  // Porsche-classes summary export — Alicia's manual workflow today is
  // "download summary → drop into PCNA SharePoint folder". The
  // /summaries/[classKey]/upload-sharepoint route automates the drop and
  // emits one event per attempt so we can prove the automation
  // (a) ran for the right class, and (b) when it gracefully degraded
  // (skipped_reason captures why — not_configured / no_token /
  // graph_error). Success path includes destination web_url.
  //
  //   automations.sharepoint_upload_attempted { automation_id, class_key,
  //                                              filename, byte_count }
  //   automations.sharepoint_upload_succeeded { automation_id, class_key,
  //                                              filename, byte_count,
  //                                              web_url }
  //   automations.sharepoint_upload_skipped   { automation_id, class_key,
  //                                              filename, skipped_reason,
  //                                              status? }
  | "automations.sharepoint_upload_attempted"
  | "automations.sharepoint_upload_succeeded"
  | "automations.sharepoint_upload_skipped"
  // Porsche-classes operator setup wizard
  // (/automations/porsche-classes/setup) — non-technical operators
  // configure ingest mailbox filters + SharePoint destination without
  // touching env vars. Events fire from
  // /api/automations/porsche-classes/config and /sharepoint-test.
  //
  //   automations.config_viewed       { automation_id }
  //     — operator opened the wizard and the GET /config call returned.
  //
  //   automations.config_updated      { automation_id, fields }
  //     — operator saved a new config row. fields=comma-joined list of
  //       which payloads changed (inbox_filters / sharepoint).
  //
  //   automations.sharepoint_test_run { automation_id, ok, status? }
  //     — sharepoint-test endpoint hit Graph; ok=true on a 2xx folder
  //       lookup, false otherwise.
  | "automations.config_viewed"
  | "automations.config_updated"
  | "automations.sharepoint_test_run"
  // Support — operator-driven shared-mailbox ticket flow.
  //
  //   support.ticket_created    { ticket_id, category, severity }
  //   support.list_viewed       { status?, category?, count }
  //   support.ticket_updated    { ticket_id, fields_changed }
  //   support.draft_generated   { ticket_id, pattern_ids, char_count }
  //   support.ticket_sent       { ticket_id, to_email, char_count }
  //   support.feedback_submitted { ticket_id, helpful, has_edit_diff }
  //   support.poll_run            { source, mailbox, messages_seen,
  //                                 tickets_created, replies_appended,
  //                                 drafts_generated, errors, duration_ms,
  //                                 [skipped], [status] }
  //     — emitted on every inbox-poller tick (cron + operator Run-now).
  //       Used to monitor poll cadence and catch token expiry early.
  //
  //   support.categorized        { ticket_id, category, confidence, source }
  //     — emitted by the AI auto-categorizer (manual create + email
  //       ingest). Used by the learning loop to compute classifier
  //       precision over time and surface which buckets the model
  //       struggles with.
  //
  //   support.auto_acknowledged  { ticket_id, pattern_id, char_count,
  //                                latency_ms }
  //     — emitted when the auto-ack pipeline successfully sent a reply
  //       to a customer email. Used to monitor auto-ack volume per
  //       pattern and feed the success_count / fail_count loop on the
  //       pattern library.
  | "support.ticket_created"
  | "support.list_viewed"
  | "support.ticket_updated"
  | "support.draft_generated"
  | "support.ticket_sent"
  | "support.feedback_submitted"
  | "support.poll_run"
  | "support.categorized"
  | "support.auto_acknowledged"
  // /support/patterns management page (operator-facing).
  //
  //   support.patterns_viewed   { count, auto_ack_enabled_count }
  //     — emitted whenever the operator opens /support/patterns. Lets
  //       us measure how often operators inspect the pattern library
  //       and how many patterns currently have auto-ack opted in.
  //
  //   support.pattern_updated   { pattern_id, pattern_slug,
  //                               fields_changed, auto_acknowledge_enabled }
  //     — emitted on every successful PATCH /api/support/patterns/[id].
  //       The learning loop joins this stream against ticket outcomes
  //       to score auto-ack opt-in choices over time.
  | "support.patterns_viewed"
  | "support.pattern_updated"
  // Persistent AI response cache (src/lib/ai/response-cache).
  //
  //   support.cache_hit  { feature, cache_id, tokens_saved }
  //     — emitted whenever lookupCachedResponse returns a hit. `feature`
  //       is one of 'support.draft' | 'support.categorize' |
  //       'support.auto_ack'. `tokens_saved` is the cached response's
  //       input_tokens + output_tokens. Used to surface the cache's
  //       running token-savings headline metric on the analytics
  //       dashboard.
  | "support.cache_hit"
  // Operator-facing AI-savings analytics page (/support/analytics or
  // wherever the dashboard lives). Fires on every successful read of the
  // /api/support/analytics aggregator so the learning system can see how
  // often operators inspect the cost-savings dashboard.
  //
  //   support.analytics_viewed { window }
  //     — `window` is one of 'today' | '7d' | '30d' | 'all'.
  | "support.analytics_viewed"
  // AI provider abstraction (src/lib/ai). Emitted on every model call so
  // we can attribute spend per feature, watch latency, and detect when
  // the failover path is firing.
  //
  //   ai.completion { feature, provider, model, tier, input_tokens,
  //                   output_tokens, cost_usd, latency_ms, fallback_used,
  //                   sensitivity? }
  | "ai.completion";

export interface InstinctEvent {
  event_type: InstinctEventType;
  user_id: string;
  user_role: string;
  metadata: Record<string, string | number | boolean>;
  timestamp?: string;
}

/**
 * Track an event. Fire-and-forget — never blocks, never throws.
 */
export function trackEvent(
  event: InstinctEventType,
  userId: string,
  userRole: string,
  metadata: Record<string, string | number | boolean> = {},
): void {
  if (!process.env.DATABASE_URL) return;

  const ts = new Date().toISOString();
  query(
    `INSERT INTO instinct_events (event_type, user_id, user_role, metadata, timestamp)
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
       FROM instinct_events
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
