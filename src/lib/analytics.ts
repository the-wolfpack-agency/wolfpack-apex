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
  | "feature.request_write_failed"
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
  | "studio.publish_clicked";

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
