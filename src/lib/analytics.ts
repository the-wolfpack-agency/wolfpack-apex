/**
 * Instinct Analytics - Every interaction feeds the learning loop.
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
  // Cache-write veto from saveAnswer when the candidate answer looks
  // wrong (e.g. past-tense verb + future date - hallucinated). Metadata:
  // { reason, source, tokens_used }.
  | "knowledge.answer_rejected"
  | "knowledge.doc_generated"
  | "knowledge.doc_downloaded"
  | "knowledge.doc_revised"
  // Documents (generated docs page) - edit/delete. Separate from the legacy
  // knowledge.doc_* events so the learning loop can distinguish generator
  // churn from human curation.
  //   docs.edited   { doc_id }
  //   docs.deleted  { doc_id }
  | "docs.edited"
  | "docs.deleted"
  | "knowledge.codebase_searched"
  // Central Brain - team-wide document ingestion + RAG
  | "brain.upload_started"
  | "brain.upload_completed"
  | "brain.upload_rejected"
  // Upload-to-Brain widget pre-ingest filter lifecycle. Fires from the
  // /api/brain/upload route which runs the data-quality filter BEFORE
  // delegating to ingest(). `brain.upload_attempted` fires for every
  // POST regardless of outcome (pre-filter audit, never lost). The
  // accepted variant fires when the filter passes AND ingest succeeds.
  // The rejected variant carries the `reasons` array from the filter
  // so the learning loop sees which gates fire most. Metadata:
  //   brain.upload_attempted  { content_hash, file_size, mime_type }
  //   brain.upload_accepted   { content_hash, document_id }
  //   brain.upload_rejected   { reasons: string[], content_hash?, mime_type? }
  //     (NOTE: brain.upload_rejected is shared with the legacy ingest
  //      path; the widget-driven path always passes a `reasons` array.)
  | "brain.upload_attempted"
  | "brain.upload_accepted"
  // Upload widget opened - the assistant served an UploadToBrainWidget
  // and the user has the panel mounted. Tracks demand for the surface
  // independent of whether the user actually drops anything.
  | "assistant.upload_widget_opened"
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
  //     - the lazy transformers.js MiniLM pipeline finished its first
  //       load. `size_bytes` is a best-effort total of fetched weight
  //       bytes; 0 when the loader could not observe the network.
  //
  //   brain.embedding_model_load_failed   { error }
  //     - load failed or timed out. The caller falls back to the
  //       Level-1 fingerprint path; the user still sees cached results
  //       when available.
  //
  //   brain.query_embedded                { duration_ms }
  //     - per-call embedding timing, not including model load. Lets the
  //       learning loop see the steady-state encode cost.
  //
  //   brain.ann_search_performed          { workspace, chunk_count,
  //                                          top_k, duration_ms }
  //     - one full Level-2 search finished. `chunk_count` is the number
  //       of pack chunks we scored against; `duration_ms` includes
  //       keyword + semantic + merge.
  //
  //   rag.served_from_pack                { workspace, top_score,
  //                                          is_fuzzy }
  //     - fires on every Level-2 hit that returns to the caller, so
  //       the offline-hit dashboards can distinguish pack-served from
  //       fingerprint-served cache hits.
  | "brain.embedding_model_loaded"
  | "brain.embedding_model_load_failed"
  | "brain.query_embedded"
  | "brain.ann_search_performed"
  | "rag.served_from_pack"
  // Brain Pack Level-2 - progressive download / sync lifecycle (Stream U3).
  //
  //   brain.pack_sync_started      { workspace, resume }
  //     - a sync cycle kicked off. `resume` is true when we're continuing
  //       a previously-aborted sync by carrying the server cursor forward.
  //
  //   brain.pack_page_downloaded   { workspace, page_chunks, total_cached,
  //                                   duration_ms }
  //     - one page landed in IDB. `total_cached` is the running count of
  //       cached chunks for the workspace AFTER this page applied.
  //
  //   brain.pack_sync_completed    { workspace, downloaded, skipped,
  //                                   failed, duration_ms }
  //     - the sync finished naturally (no more pages / cursor exhausted).
  //
  //   brain.pack_sync_skipped      { reason }
  //     - the sync was short-circuited before any network. `reason` is
  //       one of "save_data" | "cellular" | "offline" | "quota_exceeded"
  //       | "already_running". Save-data + cellular respect user prefs;
  //       quota_exceeded fires after a QuotaExceededError from IDB.
  //
  //   brain.pack_chunk_evicted     { workspace, reason }
  //     - a cached chunk was evicted (workspace cleared, LRU trim on
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
  // Journal UX - density toggle + day-group collapse so the learning loop
  // can see which density users prefer and whether default-collapsing old
  // days actually shortens the scroll as designed.
  //   journal.density_toggled: { density: "compact"|"comfortable" }
  //   journal.group_collapsed: { date: "YYYY-MM-DD", collapsed: boolean }
  | "journal.density_toggled"
  | "journal.group_collapsed"
  // Offline draft creation (Path C · Stream U1 - text-draft offline)
  //
  // Fires ONLY on the queue path (i.e. the user created the draft
  // offline or the server was unreachable). Online inline creates do
  // NOT fire these - the underlying create endpoint already emits its
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
  // Simplified "quick add" path - one textarea + optional title. Fires on
  // submit so the learning loop can grade how often users reach for the
  // simple path vs the Advanced structured form.
  //   knowledge.quick_add: { used_title: boolean, content_length: number,
  //                           classified_as: "qa"|"note" }
  | "knowledge.quick_add"
  // Semantic Q&A cache (migration 108) - powers /knowledge "Ask a
  // Question" + /assistant Support mode. The learning-loop story:
  //   * qa_lookup tells us cache-hit rate over time. If hit-rate climbs
  //     the cache is paying off; if it stalls we know to seed more
  //     internal-doc rows.
  //   * qa_ai_generated only fires on a MISS, with token cost. The
  //     dashboard subtracts (lookup_count * cached cost) - (miss costs)
  //     to show "tokens saved by the cache".
  //   * qa_feedback drives auto-flagging - qa-cache.askWithCache refuses
  //     to serve rows where not_helpful_count > 5 and helpful_count = 0,
  //     so a bad answer stops poisoning future requests.
  //   * assistant.support_query measures whether self-serve actually
  //     deflects tickets (fell_back_to_ticket=false on first lookup,
  //     true if the user later clicks the ticket CTA).
  | "knowledge.qa_lookup"
  | "knowledge.qa_ai_generated"
  | "knowledge.qa_feedback"
  // Goals (company OKRs / KRs / contributions - migration 079).
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
  // Calendar page - week/month/year views + suggestion engagement.
  | "calendar.page_viewed"
  | "calendar.view_changed"
  | "calendar.range_computed"
  | "calendar.suggestion_viewed"
  | "calendar.suggestion_acted_on"
  // Calendar meeting link click-through - fired when the user clicks the
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
  // Meeting-Insights ingest (org-shared automation feeds - Stream B).
  //   meeting_insights.attachment_downloaded   { feed_slug, message_id,
  //                                              attachment_id, filename,
  //                                              mime, size_bytes }
  //     - fires when a user with `meetings.export` pulls the raw bytes.
  //   meeting_insights.attachment_text_viewed  { feed_slug, message_id,
  //                                              attachment_id,
  //                                              extraction_status, mime }
  //     - fires when the AttachmentBlock UI expands to read parsed text.
  | "meeting_insights.attachment_downloaded"
  | "meeting_insights.attachment_text_viewed"
  // Phase 4 - calendar-event meeting brief.
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
  // Phase 5 - ad-hoc multi-term analyze.
  //   meeting_insights.analyze_run: server-side per /api/meetings/analyze
  //     hit. metadata = { matched, analyzed, feeds_touched,
  //                       subject_filter_count, sender_filter_count,
  //                       since, until }
  | "meeting_insights.analyze_run"
  // MS 365 Insights panel - patterns computed from calendar + tasks + email.
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
  // Features board - owner/admin CRUD (PUT + DELETE on /api/features/[id]).
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
  // Discussions - edit/delete (thread + comment). Fires on every mutation
  // so the learning loop sees churn rate per discussion + per author.
  //   discussions.discussion.edited   { discussion_id }
  //   discussions.discussion.deleted  { discussion_id }
  //   discussions.comment.edited      { reply_id, discussion_id }
  //   discussions.comment.deleted     { reply_id, discussion_id }
  | "discussions.discussion.edited"
  | "discussions.discussion.deleted"
  | "discussions.comment.edited"
  | "discussions.comment.deleted"
  // Discussions - offline queueing (Stream U2 templated offline rollout).
  // Fired ONLY on the queue path: navigator.onLine===false, or an inline
  // POST that returned non-ok / threw mid-flight. Inline 2xx writes keep
  // firing the existing server-side `discussion.thread_created` /
  // `discussion.reply_posted` events. On reconnect the queue drains and
  // emits `offline.mutation_replayed` / `offline.mutation_replay_failed`
  // from offline-queue itself - no new replay-side events needed.
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
  // Client records - owner/admin CRUD (PUT + DELETE on /api/clients/[id]).
  // Split out so analytics dashboards can slice "sales churn on client
  // records" independently from doc/email activity.
  | "clients.edited"
  | "clients.deleted"
  // System
  | "system.login"
  /* Unified Microsoft sign-in flow - _started fires when the user
     clicks "Sign in with Microsoft" on /login; _denied when the OAuth
     profile resolves to an email outside the org domain. */
  | "system.microsoft_signin_started"
  | "system.microsoft_signin_denied"
  | "system.login_rate_limited"
  | "system.page_viewed"
  | "system.ai_call_made"
  | "system.ai_call_skipped"
  | "system.search_performed"
  // A Universal Search provider (chats, emails, calendar, knowledge,
  // CRM, …) threw or rejected. Total response degrades gracefully -
  // other providers' results still flow through. Payload: { provider,
  // message } - no PII, error text only.
  | "system.search_provider_failed"
  | "system.analytics_queried"
  // Tenant-isolation coverage scan (/api/cron/tenant-isolation-scan). One event
  // per recorded scan so the learning loop tracks the cross-tenant-leak gap over
  // time. metadata: { scoped_tables, total_offenders, unclassified, source,
  // <per-class counts...> }. `unclassified` MUST trend at 0.
  | "system.tenant_isolation_scanned"
  /* Unified "Scan a document" router on /finance/invoices - emitted
     when a user drops a file in either Invoice or Receipt mode so the
     learning loop can see WHICH intake surface the user chose and
     WHICH downstream resource (scan_id) was created. Payload:
     { type: "invoice" | "receipt", scan_id }. */
  | "system.scan_document_routed"
  /* Document recognition pipeline (migration 158, /api/documents/recognize).
     One event per pipeline run, regardless of success. The learning loop
     uses these to track classifier accuracy and extractor outcomes.
     Payload: { recognition_id, classified_type, classification_confidence,
     extractor_key, success, pii_blocked, classifier_latency_ms,
     extractor_latency_ms, total_cost_cents, error_kind? }. */
  | "system.document_recognized"
  /* Fired when a user reclassifies a recognized document. Strong learning
     signal - the classifier got it wrong (or the extractor confused them).
     Payload: { recognition_id, original_type, corrected_type }. */
  | "system.document_recognition_corrected"
  /* Assistant chat live-update sync. Three events feed the learning
     loop so we can see which mechanism delivers updates in practice.
     If BroadcastChannel covers ~95% of catches we can relax the poll;
     if polling carries the load the poll cadence stays put.
       chat_synced_via_broadcast { conversation_id, lag_ms }
       chat_synced_via_poll       { conversation_id }
       chat_messages_updated      { conversation_id, delta, reason } */
  | "assistant.chat_synced_via_broadcast"
  | "assistant.chat_synced_via_poll"
  | "assistant.chat_messages_updated"
  // Dashboard - personalized Quick Actions tile.
  //
  //   dashboard.quick_actions_rendered
  //     { source: "personalized" | "fallback", action_count }
  //     - fired once on mount when the Quick Actions card hydrates so
  //       the learning loop knows which users got personalized vs. the
  //       static cold-start list.
  //
  //   dashboard.quick_action_clicked
  //     { href, position, source: "personalized" | "fallback" }
  //     - fired when a tile is clicked. Click-through rate per
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
  // Tool succeeded (handler returned ok:true). Metadata: { tool, duration_ms }.
  | "assistant.tool_succeeded"
  // Tool failed (validation, capability, no_match, needs_confirmation, internal).
  // Metadata: { tool, code, message }.
  | "assistant.tool_failed"
  // OGIAM (deterministic AI authorization) decisions, Phase 0 shadow mode.
  // ogiam.action_authorized  { decision_id, tool, capability, risk_tier,
  //                            intended_outcome, enforced, rule_id, policy_version }
  //   fired when the gate would ALLOW or TRANSFORM the action.
  // ogiam.action_flagged     same metadata, fired when the intended outcome
  //   would BLOCK (deny or escalate). The headline shadow-mode signal: what
  //   enforcement would have stopped, so we can tune before enforcing.
  | "ogiam.action_authorized"
  | "ogiam.action_flagged"
  | "ogiam.action_blocked_unauditable"
  // ogiam.checkpoint_signed  { workspace_id, through_seq, algorithm, key_id,
  //                            signed, chain_ok, verified_count }
  //   fired when the scheduled sweep notarizes a workspace's decision chain by
  //   signing its head. signed=false means the chain verified but no signer was
  //   configured (tamper-evident, not yet non-repudiable). chain_ok=false means
  //   verification failed and the chain was NOT signed.
  | "ogiam.checkpoint_signed"
  // ogiam.signing_selftest  { mode, signed, verified, latency_ms }
  //   fired when an admin probes the signing wiring (sign a server-generated
  //   probe, then independently verify it). No secrets in the payload.
  | "ogiam.signing_selftest"
  // ogiam.enforcement_posture_changed { capability, mode, prev_mode } - an admin
  //   graduated a capability's gate posture (monitor <-> enforce). The control
  //   knob that turns "we logged what it would do" into "we blocked it".
  | "ogiam.enforcement_posture_changed"
  // ogiam.policy_simulated { window_days, decisions, candidate_capabilities,
  //   newly_blocked, currently_blocked } - an admin replayed a candidate enforce
  //   set over the recorded decision ledger to see its blast radius BEFORE
  //   enforcing. Proves the cross-execution data is a decision-support asset.
  | "ogiam.policy_simulated"
  // ogiam.trends_viewed { window_days, buckets, source } - an admin opened the
  //   governance drift-trends view (gate-decision volume + outcome mix, red-team
  //   pass-rate history, ungoverned-AI-surface count over time). The renewal
  //   story: the line goes down and stays down.
  | "ogiam.trends_viewed"
  // ogiam.drift_alert_dispatched { alert_kind, fingerprint, recipient_count } -
  //   a governance regression (red-team pass-rate drop, a new vuln, or a new
  //   ungoverned AI surface) crossed a threshold and was fanned out through the
  //   notifications layer. Deduped by (workspace_id, alert_kind, fingerprint) so
  //   the same condition never re-alerts.
  | "ogiam.drift_alert_dispatched"
  // AI Surface Inventory (shadow-AI discovery). You cannot govern what you cannot
  // see: these track the inventory of AI touchpoints found in a client's code and
  // the "ungoverned AI" gap over time, the foundation the other AI-governance
  // surfaces register into.
  // ai_inventory.scan_completed { target, surfaces, ungoverned, written }
  | "ai_inventory.scan_completed"
  // ai_inventory.viewed { total, ungoverned } - an admin opened the inventory.
  | "ai_inventory.viewed"
  // ai_inventory.repo_scan_completed { repo, files_scanned, surfaces, ungoverned }
  //   - a live scan of a public GitHub repo populated the inventory (the wedge's
  //   single most convincing demo moment).
  | "ai_inventory.repo_scan_completed"
  // ai_inventory.remediation_suggested { kind, provider } - one per ungoverned
  //   surface, so the learning loop sees which AI gaps recur across client code.
  | "ai_inventory.remediation_suggested"
  // MCP (Model Context Protocol) static scanner. Governs the new MCP attack
  // surface without our core ever connecting to a server.
  // mcp.scan_completed  { target, servers, findings, critical, high }
  | "mcp.scan_completed"
  // mcp.finding_detected { server, class, severity } - one per MCP risk found,
  //   so the learning loop sees the threat distribution across client setups.
  | "mcp.finding_detected"
  // AI-code governance: a deterministic gate over AI-authored diffs before merge.
  // ai_code.reviewed { ref, author, outcome, findings, highest_severity }
  | "ai_code.reviewed"
  // ai_code.finding_detected { class, severity, cwe } - one per code risk, so the
  //   learning loop mines what AI tools keep introducing.
  | "ai_code.finding_detected"
  // Continuous AI red-team: an adversarial corpus run against the gate.
  // ai_redteam.run_completed { attacks, blocked, vulns, pass_rate, source }
  | "ai_redteam.run_completed"
  // ai_redteam.vuln_detected { category, technique, attack_id } - one per attack
  //   that got through (a gate regression). The healthy state emits none.
  | "ai_redteam.vuln_detected"
  // Compliance engine: framework coverage generated from measured evidence.
  // compliance.report_generated { framework, coverage, covered, partial, gap }
  | "compliance.report_generated"
  // compliance.gap_detected { framework, control_id } - one per uncovered control,
  //   so the learning loop watches the gaps close over time.
  | "compliance.gap_detected"
  // compliance.evidence_exported { framework, report_id, signed } - a signed,
  //   forwardable evidence artifact was generated for a stored report.
  | "compliance.evidence_exported"
  // Agent principals (OGIAM, agents onboarded like people).
  // agent.created          { agent_id, role, owner_user_id, identity_provider }
  //   an admin onboarded an agent through the invite flow.
  // agent.activated        { agent_id, workspace_id }
  //   the agent presented its onboarding secret and got its first token.
  // agent.lifecycle_changed { agent_id, state }
  //   paused, resumed, or revoked.
  // agent.token_issued     { agent_id, ttl_seconds }
  //   a short-lived access token was minted for the agent.
  | "agent.created"
  | "agent.activated"
  | "agent.lifecycle_changed"
  | "agent.token_issued"
  // agent.invite_emailed   { agent_id }
  //   an admin emailed the invitee the join link + one-time onboarding secret.
  | "agent.invite_emailed"
  // agent.scan_completed  { agent_id, workspace_id, scan_version, tool_count,
  //                         allowed_tool_count, capability_count }
  //   the agent ran its self-onboarding scan and stored its system model.
  // agent.acted           { agent_id, tool, allowed, rule_id? }
  //   the agent drove a tool dispatch as itself; allowed reflects whether the
  //   OGIAM enforce gate let it through.
  | "agent.scan_completed"
  | "agent.acted"
  // Write approvals (human-in-the-loop): a mutation an agent proposed is captured
  // pending approval, then approved/rejected by a human, then executed.
  | "agent.write_pending_approval"
  | "agent.write_approved"
  | "agent.write_rejected"
  | "agent.write_executed"
  // agent.task_assigned   { agent_id, task_id, workspace_id }
  //   a human assigned work to an agent.
  // agent.task_completed  { agent_id, task_id, status, step_count, ran_count, blocked }
  //   the agent finished running an assigned task (succeeded, blocked for
  //   approval, or failed), every step governed under its identity.
  | "agent.task_assigned"
  | "agent.task_completed"
  // agent.log_viewed      { agent_id, decision_count }
  //   a manager opened an agent's action log (the OGIAM decision ledger). The
  //   ledger is the IAM audit trail and the same data the drift detector and
  //   procedure-learning loop consume, so a review is itself a learning signal.
  | "agent.log_viewed"
  // agent.fleet_viewed { total, active, paused, invited, connected }: a manager
  // opened the agent fleet console. Engagement signal for the learning loop.
  | "agent.fleet_viewed"
  // agent.detail_opened { agent_id, state }: drilled into a single agent.
  | "agent.detail_opened"
  // agent.command_view_viewed { agent_id, decision_count, run_count }: opened the
  // single-agent command view.
  | "agent.command_view_viewed"
  // agent.execution_grounded { agent_id, task_id, inherited, brain_hits,
  //                            brain_grounded, model_id?, est_cost_usd? }
  //   one row per agent run capturing the maturation / familiarity curve:
  //   whether the run reused a deterministic learned procedure (inherited,
  //   zero token consideration) or explored, and when it explored, whether it
  //   grounded in the org Brain and which best-priced model the cost-aware
  //   router picked. The deterministic-vs-AI ratio over time is the
  //   "gets cheaper as it learns the system" signal.
  | "agent.execution_grounded"
  // Cumulative agent memory (one agent's learning benefits the next).
  // agent.procedure_learned  { workspace_id, goal_key, status, step_count }
  //   a succeeded task became a candidate procedure.
  // agent.procedure_promoted { workspace_id, goal_key, manual? }
  //   the procedure passed the adversarial safety check and is now inheritable.
  // agent.procedure_rejected { workspace_id, goal_key, reason, manual? }
  //   a step would now be blocked, so the procedure is not shared.
  // agent.procedure_inherited { workspace_id, goal_key, learned_by_agent }
  //   a later agent reused a promoted procedure instead of re-exploring (the
  //   cost-plateau signal).
  | "agent.procedure_learned"
  | "agent.procedure_promoted"
  | "agent.procedure_rejected"
  | "agent.procedure_inherited"
  // Agent drift detection (the gate keeps agents in check across model changes).
  // agent.baseline_captured { agent_id, workspace_id, decision_count }
  //   a behavior baseline was snapshotted from the agent's decisions.
  // agent.drift_checked     { agent_id, workspace_id, verdict, score, action }
  //   a drift check ran (stable, drifting, critical, insufficient_data).
  // agent.auto_paused       { agent_id, workspace_id, score }
  //   the agent drifted critically and was auto-paused for owner review.
  | "agent.baseline_captured"
  | "agent.drift_checked"
  | "agent.auto_paused"
  // GOVERNED backup-agent failover for uptime (migration 184). An agent can
  // designate a BACKUP; when the primary goes unhealthy (paused/revoked) or a
  // task stalls, its queued work fails over to the backup, which runs it under
  // the SAME OGIAM gate and the SAME least-privilege scope. Failover never
  // bypasses governance and never escalates scope.
  // agent.backup_designated  { agent_id, backup_agent_id, cleared }
  //   an operator set or cleared this agent's backup designation.
  // agent.failover_triggered { primary_agent_id, backup_agent_id, task_count }
  //   an unhealthy primary's queued tasks were reassigned to a scope-compatible
  //   active backup. task_count is the number reassigned this sweep.
  // agent.task_reassigned    { task_id, from_agent_id, to_agent_id, workspace_id }
  //   one queued task moved from the unhealthy primary to the backup. The task
  //   stays 'queued' and runs as the backup under the gate (no state bypass).
  | "agent.backup_designated"
  | "agent.failover_triggered"
  | "agent.task_reassigned"
  // agent.task_reclaimed { task_id, agent_id, workspace_id, action }
  //   a stalled 'running' task (started_at older than the stall window) was
  //   freed by the reclaimer: action 'requeued' (back to 'queued', under the
  //   retry cap) or 'failed' (over the cap, marked 'failed' so a permanently
  //   stuck task can never loop forever). A dead agent leaves a stuck task; this
  //   frees it so failover can pick it up.
  | "agent.task_reclaimed"
  // agent.failover_swept { reclaimed, reassigned, skipped }
  //   one full failover cron sweep finished. reclaimed = stalled tasks freed,
  //   reassigned = queued tasks moved to a backup, skipped = unhealthy primaries
  //   whose backup was scope-incompatible or inactive (no escalation).
  | "agent.failover_swept"
  // Assistant-driven agent delegation: a user told an agent to do something.
  // agent.delegated         { agent_id, task_id, status }
  //   a human delegated a task to an agent from the assistant chat.
  | "agent.delegated"
  // Agent↔connection association layer (migration 183). An operator binds a
  // reusable workspace connector credential to an agent to build "a Salesforce
  // agent", "a Jira agent", etc. The connection stays workspace-scoped; this
  // only records the association lifecycle.
  // agent.connection_bound   { agent_id, connector_name }
  // agent.connection_unbound { agent_id, connector_name }
  | "agent.connection_bound"
  | "agent.connection_unbound"
  // agent.connector_scope_denied { connector, workspace_id } — least-privilege: an agent targeted a connector it is NOT bound to (instinct_agent_connections); refused before any connector was built.
  | "agent.connector_scope_denied"
  // Platform scan: an agent crawls a TARGET external platform's routes and
  // classifies each into a finding (bug / ux gap / broken journey / security /
  // performance). This is how an agent familiarizes with a client platform and
  // surfaces use-case gaps + bugs across the journey.
  // platform.scan_started          { platform, route_count }
  // platform.scan_finding_detected { platform, route, severity, category }
  // platform.scan_completed        { platform, route_count, finding_count, critical_count }
  // platform.scan_finding_triaged  { platform, route, severity, status }
  // platform.scan_findings_bulk_triaged { status, count, severities, platform }
  // platform.scan_findings_auto_resolved { platform, count, scan_id }
  // platform.system_profiled { platform, entities, integrations, routes, criticals }
  | "platform.system_profiled"
  // platform.target_onboarded { platform, has_static, has_api } / target_offboarded { platform }
  | "platform.target_onboarded"
  | "platform.target_offboarded"
  // platform.recommendations_generated { platform, count, criticals }
  | "platform.recommendations_generated"
  // platform.recommendation_triaged { status, key }
  | "platform.recommendation_triaged"
  // platform.engagement_run { platform, findings, criticals, auto_resolved, recommendations }
  | "platform.engagement_run"
  // platform.remediation_pr_opened { platform, key, pr_url, gate_outcome }
  | "platform.remediation_pr_opened"
  // platform.preflight_run { platform, ok, checks, failed }: onboarding readiness check
  | "platform.preflight_run"
  // Scan politeness: a probe backed off to avoid overwhelming a client system.
  // { platform, host, retry_after_ms, reason }
  | "platform.scan_throttled"
  // Gate-governed browser automation: every action an AI driver (openclaw or any
  // framework) wants to take is authorized by the OGIAM gate first. Read-only
  // observe/navigate is allowed on a verified target; a mutating action is denied
  // unless an active ui_probe scope authorizes it. { platform, action, reason }
  | "platform.browser_action_allowed"
  | "platform.browser_action_blocked"
  // Continuous sweep observability: a sweep run finished / failed, so a silently
  // broken sweep (stale client posture) is visible. { kind, targets, succeeded, failed }
  | "platform.sweep_completed"
  | "platform.sweep_failed"
  // UX/accessibility posture grade for a target, trended over time like the
  // security posture. { platform, grade, ux, a11y, total }
  | "platform.ux_posture_scored"
  // Bring-your-own-agent gate API: an EXTERNAL agent (any model/framework) asked the
  // OGIAM gate to authorize an action via an API key. Every external decision is a
  // learning surface. authorized { agent, tool, outcome } / blocked { reason }
  | "platform.gate_api_authorized"
  | "platform.gate_api_blocked"
  // Tier-2 agentic journey-friction: a gated journey attempt was evaluated for
  // excessive steps / dead-ends. { platform, journey, steps, expected, friction }
  | "platform.journey_evaluated"
  // Ingest abuse protection: an observation/findings/traces ingest was refused for
  // exceeding a rate or payload cap. { reason, workspace_id }
  | "platform.scan_ingest_rejected"
  // Gate self-verification: a batch of decisions was run to PROVE the gate is correct,
  // fast, and auditable. { correct, total, p50_ms, p95_ms, chain_verified }
  | "platform.gate_selftest_run"
  // Active-learning benchmark: the scanner ran against the consent-to-test corpus
  // (self-hosted vulnerable apps + our own) and was scored vs ground truth.
  // { targets, recall, precision, coverage_classes, errored }
  | "platform.benchmark_run"
  // A learning signal mined from the benchmark: a ground-truth class we failed to
  // detect (coverage gap) or a class firing far above truth (noise candidate).
  // { kind: "coverage_gap" | "noise_candidate", finding_class, detail }
  | "platform.learning_signal_detected"
  // Competitive benchmark: a third-party scanner (zap, nuclei, semgrep, trivy) was
  // scored against the SAME consent corpus + ground truth as us, head to head.
  // { tool, target, recall, precision, findings }
  | "platform.competitor_benchmark_run"
  // A class a competitor detected that we missed on the same target: a prioritized
  // coverage gap with a named rival. { tool, target, finding_class, expected_severity }
  | "platform.competitor_gap_detected"
  // We matched or beat every competitor on a target (no rival-only class): proof
  // signal for client-facing parity claims. { target, tools_compared }
  | "platform.competitive_parity_confirmed"
  // Cross-scan correlation: findings from DIFFERENT modalities (frontend, backend,
  // db, security, ux) or executions were linked into one higher-order insight no
  // single-layer scanner can see. { insight_kind, severity, modalities, member_count, platform }
  | "platform.cross_scan_insight_generated"
  // A compound-risk correlation: independent findings that chain into an exploit
  // path greater than their parts. { platform, chain_length, peak_severity, route? }
  | "platform.cross_scan_correlation_detected"
  // A previously-resolved finding reappeared in a later scan (regression). Fed back
  // to learning + surfaced to the client. { platform, finding_class, route?, gap_days }
  | "platform.cross_scan_regression_detected"
  // A read (corpus/findings load) failed and was swallowed, so the downstream
  // result is PARTIAL not empty-because-clean. Mandatory signal so the learning
  // loop never mistakes a degraded run for a real result. { surface, detail }
  | "platform.scan_read_degraded"
  // A persistence write failed after the result was computed: the value was
  // returned/served but NOT durably stored. Never report silent success.
  // { surface, detail }
  | "platform.scan_persist_degraded"
  // Release gate: a built change is blocked from reaching production (e.g.
  // awaiting approval, checks failing). Surfaced in-product so no one silently
  // stalls a deploy. { pr_number, state, reason, age_hours }
  | "deploy.release_blocked_detected"
  // An operator opened the release gate (dashboard banner or /admin/deployment).
  // { blocking_count }
  | "deploy.release_gate_viewed"
  // A notification was sent because a change has been blocking prod past the
  // threshold. { pr_number, channel, age_hours }
  | "deploy.release_unblock_notified"
  // A change was promoted to production from inside the product (release gate
  // Promote action), not via the GitHub UI. { pr_number, merged_sha }
  | "deploy.production_promoted"
  // Client engagement with the redesigned consoles: results actually viewed. These
  // close the learning loop on what clients look at. { open_total, critical, high, targets }
  | "platform.results_viewed"
  // { band, platform } a severity filter was toggled on the scan console.
  | "platform.severity_filter_toggled"
  // Target authorization: a target must be proven client-owned (well-known token
  // or DNS TXT) before any scan/pentest runs. Fail-closed at the target level.
  // platform.target_verification_requested { platform, method }
  | "platform.target_verification_requested"
  // platform.target_verified { platform, method }
  | "platform.target_verified"
  // platform.target_verification_failed { platform, method, reason }
  | "platform.target_verification_failed"
  // platform.scan_blocked_unverified { platform, action }: a scan/pentest was
  // refused because the target is not verified as client-owned.
  | "platform.scan_blocked_unverified"
  // platform.deployment_readiness_checked { ok, checks, failed }: env blockers +
  // backing-service reachability gate before a client deployment goes live.
  | "platform.deployment_readiness_checked"
  // platform.scan_coverage_degraded { platform, attempted, succeeded, errored,
  // auth_ok }: a scan that could not fully cover the target (so a 0-findings
  // result is NOT a clean bill). Feeds the learning loop on flaky targets.
  | "platform.scan_coverage_degraded"
  // Active-pentest safety harness: scope tokens (rules of engagement) + guard.
  // pentest.scope_issued { platform, techniques, max_requests, ttl_minutes }
  | "pentest.scope_issued"
  // pentest.scope_revoked { platform, scope_id, all }
  | "pentest.scope_revoked"
  // pentest.probe_authorized { platform, technique, scope_id }
  | "pentest.probe_authorized"
  // pentest.probe_blocked { platform, technique, reason }
  | "pentest.probe_blocked"
  // pentest.idor_completed { platform, cases, confirmed }
  | "pentest.idor_completed"
  // pentest.rate_limit_completed { platform, cases, confirmed }
  | "pentest.rate_limit_completed"
  // pentest.info_disclosure_completed { platform, cases, confirmed }
  | "pentest.info_disclosure_completed"
  // pentest.engagement_run { platform, casesRun, confirmed }
  | "pentest.engagement_run"
  // pentest.auth_bypass_completed { platform, cases, confirmed }
  | "pentest.auth_bypass_completed"
  // pentest.injection_completed { platform, cases, confirmed }
  | "pentest.injection_completed"
  | "platform.scan_started"
  | "platform.scan_finding_detected"
  | "platform.scan_completed"
  | "platform.scan_finding_triaged"
  | "platform.scan_findings_bulk_triaged"
  | "platform.scan_findings_auto_resolved"
  // Demo-login canary: a continuous end-to-end proof that the scan tool still
  // logs into demo target platforms, runs a scan, and surfaces the expected
  // findings — catching a regression (login broke / scan broke / a known-buggy
  // demo's findings dropped to zero) BEFORE a client does.
  // canary.demo_run    { name, login_ok, scan_ok, finding_count, healthy } — one per canary target per run.
  // canary.demo_failed { name, login_ok, scan_ok, finding_count, reason }  — fires only for an UNHEALTHY target.
  | "canary.demo_run"
  | "canary.demo_failed"
  // Universal-search assistant tool (`search`). Fired by the tool's
  // handler after runSearch returns successfully so the learning loop
  // sees parity with the /search page route's `insight.search.queried`
  // event, but namespaced under `assistant.*` so the funnel slices
  // chat-driven searches independently from page-driven ones.
  //   assistant.search_executed   { query_length, total_results,
  //                                  took_ms, types, workflow_id? }
  //   assistant.search_no_results { query_length, types, workflow_id? }
  //     - fires when total_results === 0; pairs with the page-surface
  //       `insight.search.no_results` for docs-gap heatmaps.
  | "assistant.search_executed"
  | "assistant.search_no_results"
  // Per-provider telemetry for Universal Search. One event fires per
  // provider per request - chats, channels, emails, calendar,
  // knowledge, crm, and any future provider - so the learning loop
  // can rank providers by latency and recall independently. Payload:
  //   assistant.search_provider_executed { provider, query_length,
  //                                         match_count, took_ms,
  //                                         workflow_id? }
  | "assistant.search_provider_executed"
  // Action tool dispatch persisted a pending confirmation (waiting on
  // the user's next-turn "confirm" / "cancel"). Metadata: { tool,
  // pending_id, description, expires_at }.
  | "assistant.action_pending"
  // The user explicitly confirmed a pending action; the dispatcher
  // executed the underlying handler. Metadata: { tool, pending_id }.
  | "assistant.action_confirmed"
  // The user explicitly cancelled a pending action. Metadata: { tool,
  // pending_id }.
  | "assistant.action_cancelled"
  // A pending action lapsed without confirmation. Fired by the cleanup
  // path. Metadata: { count }.
  | "assistant.action_expired"
  // Phase-4 connector telemetry. Fires from every external-system
  // request the connector framework dispatches.
  //   assistant.connector_succeeded { connector, duration_ms, code:"ok" }
  //   assistant.connector_failed    { connector, duration_ms, code:
  //     "not_configured" | "auth_failed" | "rate_limited" | "not_found"
  //     | "remote_error" | "network" | "validation" }
  | "assistant.connector_succeeded"
  | "assistant.connector_failed"
  // Per-tenant connector credentials lifecycle (migration 136).
  //   assistant.connector_credentials_updated  { connector, workspace_id }
  //   assistant.connector_credentials_decrypt_failed { connector,
  //     workspace_id } - fires when an existing row's auth_header
  //     can't be decrypted (typically a key rotation mismatch).
  | "assistant.connector_credentials_updated"
  | "assistant.connector_credentials_decrypt_failed"
  | "assistant.fallback_to_rag"
  | "assistant.fallback_to_ai"
  // Related-pages chip + source chip click-through. Every response now
  // ships with `relatedPages[]` (domain → route map) and `sources[]`
  // (knowledge / brain / tool attributions). The two events below let
  // the learning loop grade which chips actually drive navigation vs.
  // which are cosmetic.
  //   assistant.link_clicked:   { domain }       - user clicked a
  //       "Related pages" chip that deep-links into /calendar etc.
  //   assistant.source_viewed:  { source_type }  - user expanded or
  //       clicked a source. `source_type` ∈
  //       {"knowledge","brain","tool","meeting","analytics"}.
  | "assistant.link_clicked"
  | "assistant.source_viewed"
  // Answer-quality filter fired (see src/lib/assistant/answer-quality.ts).
  // Metadata: { filter, severity, reason, verdict }. Drives the learning
  // loop's threshold tuning + lets us measure which filter saves the
  // most client-facing hallucinations over time.
  | "assistant.quality_flag_raised"
  // Answer-relevance eval harness fired one case.
  // Metadata: { case_id, category, passed, source_actual, source_expected?,
  // failures }. Every PR's eval run emits one event per case so the
  // learning loop sees which cases regressed when, and so we can build
  // a quality-over-time dashboard without re-running cases by hand.
  | "assistant.eval_case_executed"
  // Porsche-class grounding lookup failed (DB unreachable, query
  // error, etc.). Mirrors assistant.meeting_lookup_failed so multi-
  // source grounding errors are uniformly trackable.
  // Metadata: { status, code, scope_missing }.
  | "assistant.porsche_class_lookup_failed"
  // Meeting Pre-Brief synthesis (migration 142 + src/lib/insights/meeting-prep.ts).
  // The first cross-source synthesis tool - fans out across 5+ sources in
  // parallel, then makes a SINGLE Haiku call on cache miss. Cache key is
  // (workspace_id, meeting_id, source_hash) so every teammate sees the
  // same insight; source_hash bakes in CRM lastModified, last email
  // received timestamp, and last brain edit so stale data invalidates
  // implicitly. Learning loop: every click/expand on a talking point or
  // source ref persists to instinct_meeting_prep_signals.
  //   assistant.meeting_prep_executed       { meeting_id, workspace_id,
  //       cache_status }
  //   assistant.meeting_prep_cache_hit      { meeting_id, workspace_id,
  //       source_hash, hit_count }
  //   assistant.meeting_prep_cache_miss     { meeting_id, workspace_id,
  //       source_hash, latency_ms, model_used, input_tokens,
  //       output_tokens }
  //   assistant.meeting_prep_synthesis_failed { meeting_id, workspace_id,
  //       code, message }
  //   assistant.meeting_prep_regenerated    { meeting_id, workspace_id,
  //       source_hash, latency_ms, model_used, input_tokens,
  //       output_tokens } - manager+ clicked the regenerate button.
  //   assistant.meeting_prep_source_clicked { meeting_id, ref_type,
  //       item_index }
  //   system.meeting_prep_source_degraded   { source, error } - per
  //       source-fetch failure so we see which integrations are slow.
  | "assistant.meeting_prep_executed"
  | "assistant.meeting_prep_cache_hit"
  | "assistant.meeting_prep_cache_miss"
  | "assistant.meeting_prep_synthesis_failed"
  | "assistant.meeting_prep_regenerated"
  | "assistant.meeting_prep_source_clicked"
  | "system.meeting_prep_source_degraded"
  // OAuth lifecycle for connector credentials (migration 138 +
  // src/lib/assistant/connectors/oauth/). The orchestrator fires
  // these uniformly across providers (Salesforce, HubSpot, future
  // QBO/Jira/GitHub) so the learning loop sees connector-auth health
  // without per-vendor special cases.
  //   assistant.oauth_authorization_started  { provider, workspace_id }
  //   assistant.oauth_authorization_completed { provider, connector,
  //       workspace_id, expires_in_sec, refresh_token_present }
  //   assistant.oauth_authorization_failed   { provider, workspace_id,
  //       code, status }
  //   assistant.oauth_authorization_denied   { provider, reason }
  //   assistant.oauth_token_refreshed        { connector, workspace_id,
  //       expires_in_sec, refresh_token_rotated }
  //   assistant.oauth_refresh_failed         { connector, workspace_id,
  //       reason, status? }
  //   assistant.oauth_persist_failed         { provider, workspace_id,
  //       reason }
  | "assistant.oauth_authorization_started"
  | "assistant.oauth_authorization_completed"
  | "assistant.oauth_authorization_failed"
  | "assistant.oauth_authorization_denied"
  | "assistant.oauth_token_refreshed"
  | "assistant.oauth_refresh_failed"
  | "assistant.oauth_persist_failed"
  // Free-text search against an external connector returned N matches.
  // Metadata: { connector, object_type, query_length, match_count }.
  // Drives a "search recall" dashboard so we can spot when name
  // searches start returning 0 results (could be auth, could be empty
  // tenant data, could be a regex regression).
  | "assistant.connector_search_executed"
  // Admin disconnected a connector (soft-delete is_active=false).
  // Metadata: { connector, workspace_id }.
  | "assistant.connector_disconnected"
  | "assistant.connector_disconnect_failed"
  // Admin clicked "Verify" - health-check fired against the vendor.
  // Metadata: { connector, workspace_id, ok, duration_ms, code }.
  | "assistant.connector_verified"
  // Write executed against a CRM connector (create_external_record /
  // update_external_record after user confirmation).
  // Metadata: { op: "create"|"update", connector, object_type,
  //   field_name?, ok, duration_ms, code }.
  // Drives a write-success dashboard so a sudden auth_failed spike
  // post-token-rotation surfaces immediately.
  | "assistant.connector_write_executed"
  // Related-record search executed against a connector (Acme's
  // opportunities / Jorge's deals).
  // Metadata: { connector, parent_type, related_type, match_count }.
  | "assistant.connector_related_executed"
  // Filter-query search executed against a connector ("deals over $50k
  // closing this month"). Metadata flags which clause types were
  // present so we can dashboard the most-used filter shapes.
  | "assistant.connector_filter_executed"
  // Aggregate query executed (count / sum / avg / win-rate / top-N).
  // Metadata: { connector, object_type, operation, result_type }.
  | "assistant.connector_aggregate_executed"
  // GitHub query executed (PR search / issue search / workflow runs).
  // Metadata: { tool, repo?, state?, match_count, duration_ms, ok }.
  // Drives the GitHub-routing dashboard so we can dashboard the
  // most-used query shapes and spot 401/403 spikes after PAT rotation.
  | "assistant.github_query_executed"
  // Chat action form was offered to the user (the tool returned a
  // FormSpec instead of free text). Metadata: { form_kind,
  // prefilled_* booleans }.
  | "assistant.form_offered"
  // User submitted a chat action form. Metadata: { form_kind, ok,
  // duration_ms, code? }.
  | "assistant.form_submitted"
  // Per-form-kind events fired by the tool's `analyticsEvent` value
  // and the submit endpoint. Kept as a single union literal so the
  // type system catches typos at the call site.
  | "assistant.form_create_email_submitted"
  | "assistant.form_create_message_submitted"
  | "assistant.form_create_calendar_event_submitted"
  | "assistant.form_create_task_submitted"
  | "assistant.form_create_okr_submitted"
  | "assistant.form_create_feature_submitted"
  | "assistant.form_create_crm_record_submitted"
  // Widget surface returned by a tool. Metadata: { widget_kind, ... }.
  // Fires whenever a tool returns a WidgetSpec; the renderer also
  // fires assistant.widget_rendered when the chat surface actually
  // mounts the widget (for funnel analysis: offered vs. rendered vs.
  // interacted-with).
  | "assistant.widget_offered"
  | "assistant.widget_rendered"
  | "assistant.widget_interaction"
  // Empty-state demo tools - weather, headlines, fx. Each fires on a
  // happy path; failures auto-emit `assistant.tool_failed` via the
  // dispatcher. Metadata sketched per-event so dashboards can slice
  // by location/base/source.
  //   assistant.weather_executed   { location, success, cache_hit?,
  //                                    reason? }
  //   assistant.headlines_executed { item_count, success, cache_hit?,
  //                                    reason? }
  //   assistant.fx_executed        { base, success, cache_hit?,
  //                                    reason? }
  | "assistant.weather_executed"
  | "assistant.headlines_executed"
  | "assistant.fx_executed"
  // Search-results widget - user clicked "Search again" after toggling
  // one or more source checkboxes off. Stub event today (the chat
  // surface doesn't yet expose a programmatic re-prompt path); the
  // learning loop tracks demand so the wiring lands when a user-facing
  // re-prompt API is added. Metadata: { widget_kind, query, types,
  // workflow_id? }.
  | "assistant.search_refilter_requested"
  // User-feedback capture (`/feedback`) - slash command + dedicated
  // widget the team-onboarding session (2026-05) uses to solicit
  // honest reactions without first wiring Slack/Linear.
  //   assistant.feedback_recorded       { feedback_id, surface,
  //                                       message_length, workflow_id? }
  //     - fires from recordUserFeedback() on every successful insert
  //       (both the slash-command path and the widget-textarea path).
  //   assistant.feedback_widget_opened  { workflow_id? }
  //     - fires when FeedbackWidget mounts, so the funnel sees
  //       opened vs. submitted regardless of where the entry came from.
  //   assistant.feedback_submitted_from_widget  { workflow_id? }
  //     - distinguishes the "user typed /feedback (bare)" -> widget ->
  //       textarea -> submit path from the direct slash-command path
  //       so the dashboard can rank discovery vs. one-shot use.
  | "assistant.feedback_recorded"
  | "assistant.feedback_widget_opened"
  | "assistant.feedback_submitted_from_widget"
  // assistant.feedback_notified  { feedback_id, recipient_count, surface }
  //   fires after recordUserFeedback notifies the feedback readers (the
  //   settings.manage_team holders) so the learning loop can see reach
  //   and whether the inbox is actually being watched.
  // assistant.feedback_screenshot_stored  { feedback_id, byte_size, content_type }
  //   fires when a compose-widget screenshot is persisted alongside the
  //   feedback row, so we can measure how often bug reports carry an image.
  | "assistant.feedback_notified"
  | "assistant.feedback_screenshot_stored"
  // SharePoint connector lifecycle events (migration 139).
  // source_added/removed: admin UI added or soft-deleted a folder source.
  // sync_started/finished: every sync run is bracketed by these two.
  // file_ingest_failed: per-file failures inside a sync (don't abort run).
  | "connectors.sharepoint.source_added"
  | "connectors.sharepoint.source_removed"
  | "connectors.sharepoint.sync_started"
  | "connectors.sharepoint.sync_finished"
  | "connectors.sharepoint.file_ingest_failed"
  | "connectors.sharepoint.placeholder_indexed"
  // Invite was looked up but the expires_at column says it lapsed.
  // Drives the "ask your admin to resend" UX hint + a tenant-side
  // dashboard counter so admins see expirations before users complain.
  | "system.team_invite_expired"
  // Admin re-sent an existing pending invite, bumping its expiry.
  // Metadata: { invite_id, invited_email, invited_role, extension_days,
  // email_delivered }.
  | "system.team_invite_resent"
  // Zero-token page-facts priority hit. Fires when the assistant answers
  // a "what is / how do I use <page>" question directly from the static
  // page-facts registry, before the knowledge base or RAG priorities
  // run. Metadata: { domain, confidence }. Lets the learning loop grade
  // which pages the team actually asks about and whether the bare-name
  // and verb-phrase heuristics fire with high confidence.
  | "assistant.page_facts_hit"
  // Floating FAB - user opened the bottom-right collapsed assistant
  // from any Instinct page. Metadata carries pathname so the learning
  // loop can see where users invoke the assistant most.
  //   assistant.floating_opened: { pathname }
  | "assistant.floating_opened"
  // Support-mode lookup against the Q&A cache (migration 108). Fires on
  // every /assistant support pill query and again when the user clicks
  // the "Submit a support ticket" CTA below a low-confidence answer.
  // Metadata: { qa_id, was_cache_hit, fell_back_to_ticket }.
  | "assistant.support_query"
  // Welcome tooltip on first dashboard visit - points users at the
  // floating FAB + the Knowledge Add-info flow. Three events form
  // the funnel so the learning loop can grade activation:
  //   welcome_tooltip.shown            - GET /me/welcome-tooltip → true
  //   welcome_tooltip.dismissed        - user closed without action
  //   welcome_tooltip.knowledge_clicked - user tapped the Knowledge CTA
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
  // Email signatures (composer toolbar). Counted under the "microsoft."
  // namespace because they are inserted into Outlook-bound emails sent
  // through the Microsoft Graph mail surface.
  //   microsoft.signature_created  { signature_id, is_default }
  //   microsoft.signature_inserted { signature_id, surface, is_default,
  //                                  insert_mode: 'cursor'|'append'|'above_quote' }
  | "microsoft.signature_created"
  | "microsoft.signature_inserted"
  | "microsoft.signature_detected"
  // Per-user dashboard nav customization (instinct_user_nav_prefs).
  | "user.nav_pref_updated"
  // Dashboard action-items click-through (learning-loop signal).
  | "dashboard.action_item_clicked"
  // Operating principles platform (instinct_principles + sync cron).
  // sync_completed fires when the SharePoint doc was re-read AND
  // changed; sync_unchanged fires when the hash matched (cheap, no
  // writes); sync_failed fires on fetch/parse/DB errors.
  | "principle.sync_completed"
  | "principle.sync_unchanged"
  | "principle.sync_failed"
  // Per-user fan-out evaluator (instinct_principle_observations writes).
  | "principle.observations_recorded"
  | "principle.evaluation_failed"
  | "principle.evaluation_skipped"
  // Weekly auto-report cron.
  | "principle.weekly_report_published"
  | "principle.weekly_report_failed"
  // SharePoint write-back leg of the weekly cron - generates the .docx
  // and PUTs it into the same folder as the source principles doc.
  // _uploaded fires on a successful Graph 200/201; _upload_failed on
  // any error surface; _upload_skipped when config/connection/scope
  // make the write impossible (no nag, just visibility for learning).
  | "principle.weekly_report_uploaded"
  | "principle.weekly_report_upload_failed"
  | "principle.weekly_report_upload_skipped"
  // Self-service config (instinct_principles_config) - leadership
  // edits the SharePoint doc URL via UI instead of env vars.
  | "principle.config_updated"
  // Native principle CRUD (no SharePoint round-trip).
  | "principle.created"
  | "principle.updated"
  | "principle.retired"
  // Program cost-budget tracking (WPA template + per-client sell exports)
  | "programBudget.created"
  | "programBudget.updated"
  | "programBudget.deleted"
  | "programBudget.line_added"
  | "programBudget.line_updated"
  | "programBudget.line_deleted"
  | "programBudget.actual_recorded"
  | "programBudget.xlsx_imported"
  | "programBudget.xlsx_exported"
  | "programBudget.viewed"
  // Inbound-email surface awareness
  | "microsoft.email_unread_polled"
  | "microsoft.email_arrived_notified"
  // Self-service password reset flow
  | "auth.forgot_password_requested"
  | "auth.forgot_password_rate_limited"
  | "auth.reset_password_completed"
  // Client-side polling efficiency (badge coalesce + adaptive cadence).
  // Emitted periodically so the learning loop can track real-world idle
  // request volume + the wins from the May 2026 optimization pass.
  | "system.badge_poll_optimized"
  // Microsoft 365 Tasks (To Do)
  | "system.ms_tasks_synced"
  | "system.ms_tasks_sync_failed"
  | "system.task_viewed"
  | "system.task_completed"
  | "system.task_created"
  // Integration health (AgenticQA nightly orchestrator)
  | "integration.health_sweep"
  | "integration.health_drift_detected"
  // Unmet-intent capture - fires when no deterministic tool matched
  // and we fell through to the LLM. Highest-value signal for "what
  // should we build next." Surfaced on the admin insights page.
  | "assistant.intent_unmatched"
  // Fallback-chips affordance - fires once per fallback / low-confidence
  // reject response when we surface 3 role-tailored starter prompts as
  // inline clickable chips. Numerator for chip-CTR; pairs with a
  // future click-side event (UI emits assistant.fallback_chip_clicked
  // on tap) so we can measure whether the affordance actually rescues
  // dead-end conversations.
  | "assistant.fallback_chips_offered"
  // Rollout polish (2026-05-18) - first-visit welcome modal +
  // fallback chip click-through. Round out the chip funnel:
  //   welcome_shown          (modal renders on first visit)
  //   welcome_dismissed      (X / backdrop click - gives up)
  //   welcome_prompt_clicked (user picks one of the starter prompts)
  //   fallback_chip_clicked  (user salvages a dead-end response via
  //     a role-tailored chip surfaced inline)
  | "assistant.welcome_shown"
  | "assistant.welcome_dismissed"
  | "assistant.welcome_prompt_clicked"
  | "assistant.fallback_chip_clicked"
  // Form-field-level analytics: which fields users skip + which
  // fields trip server validation. Tells us which optional fields
  // earn their space and which required fields are confusing.
  | "assistant.form_field_skipped"
  | "assistant.form_field_invalid"
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
  // Sites - custom domain binding (033_site_domains)
  | "site.domain_added"
  | "site.domain_verified"
  | "site.domain_removed"
  | "site.domain_add_failed"
  // Sites - unauthenticated share links + client approval workflow
  // (035_share_and_approvals). `token_nonce` is the UUID stored in
  // instinct_share_tokens - never the signed blob, never the secret.
  | "site.share_link_issued"
  | "site.share_link_accessed"
  | "site.share_link_revoked"
  | "site.approval_recorded"
  | "site.changes_requested"
  | "site.approval_expired"
  // Sites - PUBLIC contact-form submissions (034_site_form_submissions).
  // Metadata NEVER contains the recipient email in plaintext; we emit a
  // boolean `had_recipient` + the reason codes only.
  | "site.form_submitted"
  | "site.form_rejected"
  | "site.form_email_sent"
  | "site.form_email_failed"
  // Sites - image-wireframe → brief generator (031)
  | "site.brief_generation_requested"
  | "site.brief_generation_succeeded"
  | "site.brief_generation_failed"
  | "site.brief_image_rejected"
  // Sites - exemplar retrieval primer (reads accepted generations per client)
  | "site.brief_exemplars_served"
  | "site.brief_exemplars_empty"
  // Sites - multi-frame wireframe upload (033)
  | "site.brief_upload_frames_added"
  | "site.brief_upload_frame_removed"
  | "site.brief_upload_reordered"
  | "site.brief_multi_frame_requested"
  | "site.brief_multi_frame_rejected"
  // Sites - starter-template picker (031)
  | "site.template_previewed"
  | "site.template_applied"
  // Sites - video section added via BriefForm (YouTube/Vimeo embeds)
  | "site.section_video_added"
  // Sites - sales/conversion sections added via BriefForm
  | "site.section_testimonial_added"
  | "site.section_pricing_added"
  | "site.section_faq_added"
  // Sites - brand theme edited via ThemeEditor (colors + font picker)
  | "site.theme_edited"
  // Sites - per-page SEO edits + favicon generation. Metadata includes
  // site_id, page_index (or -1 for defaultSeo / site-level favicon),
  // and fields_changed[] so the learning loop can tell which SEO fields
  // designers touch most. `site.favicon_generated` metadata.mode is one
  // of "url" | "auto" | "monogram".
  | "site.seo_updated"
  | "site.favicon_generated"
  // Sites - prompt-to-brief editor (029)
  | "site.brief_edit_requested"
  | "site.brief_edit_generated"
  | "site.brief_edit_failed"
  | "site.brief_edit_blocked"
  | "site.brief_edit_decided"
  // Sites - brief-edit learning loop (030)
  | "site.insights_viewed"
  | "site.insights_snapshot_taken"
  // Sites - AI image generation inside BriefForm (032)
  | "site.image_gen_opened"
  | "site.image_gen_submitted"
  | "site.image_gen_succeeded"
  | "site.image_gen_failed"
  | "site.image_gen_accepted"
  | "site.image_gen_regenerated"
  | "site.image_gen_dismissed"
  // People (HR) - benefits, employees, onboarding, insights
  | "hr.employee_added"
  // HR employee edit/delete - dotted namespace per the 2026-04 edit/delete
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
  // HR insights - grouped view (2026-04-23). Alicia asked for the
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
  // Re-anchor: an admin acknowledged a KNOWN, non-tamper chain break (e.g. the
  // seq-509 concurrency fork) at a specific seq, opening a new chain segment.
  // verifyChain honors anchored seqs; tamper at any other seq still fails.
  | "system.audit_log_reanchored"
  // Cron self-heal: authentic legacy concurrency forks (rows valid against their
  // own stored prev_hash, mis-linked by the old pre-advisory-lock race) were
  // auto-reconciled in one pass. { reconciled, fork_count, checked_count }.
  // Genuine tamper is NEVER auto-reconciled (refused -> audit_log_tamper_suspected).
  | "system.audit_log_forks_reconciled"
  // Scheduled hash-chain verification (cron) — emitted on every run with
  // { valid, checked }. Distinct from audit_log_tamper_suspected (failure-only,
  // manual/admin path); this records that the unattended verifier ran at all.
  | "audit.chain_verified"
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
  | "system.team_member_renamed"
  | "system.time_entry_recorded"
  | "system.password_changed"
  | "system.password_change_failed"
  | "system.feedback_resolved"
  | "system.feedback_reopened"
  // Microsoft 365 Mail (Mail.Send + Mail.ReadWrite for inbox surface)
  | "system.ms_mail_sent"
  | "system.ms_mail_reply_sent"
  | "system.ms_mail_reply_all_sent"
  | "system.ms_mail_forward_sent"
  | "system.ms_mail_send_failed"
  // Agent-prepared draft (created, not sent): the safe terminal step.
  | "mail.draft_created"
  | "system.ms_mail_draft_failed"
  | "system.ms_mail_read"
  | "system.ms_mail_listed"
  | "system.ms_mail_read_state_changed"
  | "system.ms_mail_archived"
  | "system.ms_mail_deleted"
  // /emails inbox surface - user-facing actions emitted via emitInsight().
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
  // Folder switching surface - Drafts / Sent / Archived feed the learning
  // loop's per-folder usage + load-latency views.
  | "insight.email.folder_changed"
  | "insight.email.folder_loaded"
  | "insight.email.draft_opened_in_composer"
  | "insight.email.draft_clicked_skipped"
  // Unsaved-draft dialog (replaces window.confirm). The "shown" event
  // fires once per dialog open; the "resolved" event fires once when
  // the user picks an action. shown_for_ms feeds the learning loop -
  // long hesitation = the draft-detection heuristic likely too aggressive.
  | "insight.email.unsaved_draft_dialog_shown"
  | "insight.email.unsaved_draft_dialog_resolved"
  // Microsoft 365 Calendar (Calendars.ReadWrite)
  | "system.ms_calendar_event_created"
  | "system.ms_calendar_event_updated"
  | "system.ms_calendar_event_deleted"
  | "system.ms_calendar_operation_failed"
  // Microsoft 365 Planner (shared team tasks - Tier 2 · Stream D)
  | "system.ms_planner_synced"
  | "system.ms_planner_task_created"
  | "system.ms_planner_task_updated"
  | "system.ms_planner_task_completed"
  | "system.ms_planner_sync_failed"
  // Microsoft 365 Groups (Tier 2 · Stream D)
  | "system.ms_groups_synced"
  | "system.ms_groups_sync_failed"
  // Microsoft Teams channels (ChannelMessage.Read.All - Tier 2 · Stream E)
  | "system.ms_teams_channels_synced"
  | "system.ms_teams_channel_messages_synced"
  | "system.ms_teams_channel_sync_failed"
  | "system.ms_teams_channel_sync_indexing_failed"
  // Microsoft online meetings (OnlineMeetings.ReadWrite.All - Tier 2 · Stream E)
  | "system.ms_online_meeting_created"
  | "system.ms_online_meeting_updated"
  | "system.ms_online_meeting_failed"
  // Microsoft 365 Directory (Tier 2 · Stream B - tenant user cache)
  | "system.ms_directory_synced"
  | "system.ms_directory_sync_failed"
  | "system.ms_directory_user_fetched"
  // Microsoft 365 Mailbox settings (Tier 2 · Stream B - OOO / auto-reply)
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
  // track which specs flap, which catch regressions, and which never fail -
  // a signal for trustworthy vs "green but uninformative" test coverage.
  | "e2e.reality_check_ran"
  // Sites - direct-manipulation (Path C Phase 1)
  | "site.viewport_changed"
  // Sites - direct-manipulation (Path C Phase 1, Stream P2)
  // Designers click any heading/body/CTA label inside the preview iframe,
  // edit inline, and the brief state updates live. These events feed the
  // learning loop with signals on:
  //   - which section types + fields designers touch most (copy-quality gap)
  //   - inline_text_edited.char_delta - whether designers shorten or
  //     expand AI-generated copy (model-tuning signal for brief-edit LLM)
  //   - preview_hovered - which sections designers inspect without editing
  //     (hover-only = "close enough"; edit = "model was off")
  | "site.inline_text_edited"
  | "site.inline_cta_edited"
  | "site.preview_hovered"
  // Sites - asset library (Path C Phase 1, Stream P3)
  // Per-client ASSET LIBRARY - logo / hero photo / product shot uploaded
  // once per client and reusable across every site. Metadata shape:
  //   client_asset_uploaded: { client_slug, kind, size_bytes, deduped }
  //     - `deduped: true` when the sha256 already existed for this client,
  //       so we bumped use_count instead of inserting a duplicate row.
  //   client_asset_reused:   { client_slug, asset_id, site_id, kind }
  //     - fires on recordAssetUsage. Reuse rate is THE key KPI for the
  //       library's value; the learning loop scores clients by how often
  //       existing assets get picked instead of re-uploaded.
  //   client_asset_deleted:  { client_slug, asset_id }
  | "client_asset_uploaded"
  | "client_asset_reused"
  | "client_asset_deleted"
  // Sites - design tokens (Path C Phase 1, Stream P4)
  // Designers edit spacing / radius / type-scale / motion / font-stack
  // tokens via the ThemeEditor. Metadata shape:
  //   site.design_token_applied:     { site_id, token_group, token_name,
  //                                    new_value }
  //     - `token_group` ∈ {"spacing","radius","typeScale","motion","font"}
  //       `token_name`  is the tier key (e.g. "md", "2xl", "weightBold")
  //       `new_value`   is the string (or stringified number) the designer
  //                     entered. For typeScale entries the name is
  //                     "<tier>.fontSize" or "<tier>.lineHeight".
  //   site.theme_token_defaults_applied: { site_id }
  //     - fires exactly once per brief when token scales are first seeded
  //       from DEFAULT_*, marking the brief as "designer-aware."
  //
  // Learning-loop note: diff between edited tokens and defaults is the
  // signal the brain distills per client. Exemplar extraction surfaces
  // the most-common override patterns to the next brief generation.
  | "site.design_token_applied"
  | "site.theme_token_defaults_applied"
  // Sites - direct-manipulation (Path C Phase 2)
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
  // Sites - brand URL import (Path C Phase 2)
  // Designer pastes a client's existing website URL; Instinct scrapes
  // its palette/fonts/logo and maps them into a SiteTheme suggestion
  // that can seed a new SiteBrief. Metadata:
  //   brand_import_requested: { url_host }
  //     - host-only, no full URL (no query PII).
  //   brand_import_completed: { url_host, palette_size, font_count,
  //                             latency_ms, had_og_image }
  //   brand_import_failed:    { url_host, reason }
  //     - `reason` ∈ BrandImportReason except "ok".
  //   brand_import_applied:   { site_id, url_host, applied_fields }
  //     - KPI for the feature: which scraped tokens do designers
  //       actually accept? `applied_fields` is a joined-string list
  //       (comma-delimited) of the theme paths the UI wrote back.
  | "brand_import_requested"
  | "brand_import_completed"
  | "brand_import_failed"
  | "brand_import_applied"
  // Sites - Figma import (Path C Phase 3)
  // Designer pastes a Figma file URL; Instinct calls the Figma REST API
  // and produces a structured SiteBrief suggestion - theme tokens plus
  // frame-to-section mapping. Higher fidelity than the HTML scraper
  // because it reads the designer's actual layers. Metadata:
  //   figma_import_requested: { file_key }
  //     - file key only, never the full URL (URLs can contain team /
  //       node / branch query params that aren't analytics-relevant).
  //   figma_import_completed: { file_key, frame_count, color_count,
  //                             font_count, latency_ms }
  //   figma_import_failed:    { file_key, reason }
  //     - `reason` ∈ FigmaImportReason except "ok".
  //   figma_import_applied:   { site_id, file_key, applied_pages_count,
  //                             applied_theme_fields }
  //     - KPI for the feature: acceptance rate of the Figma-derived
  //       suggestion. The exemplar layer distills per-client patterns
  //       (e.g. "on this client the primary palette always keeps the
  //       top-2 colors, not all 4") for the next import.
  | "figma_import_requested"
  | "figma_import_completed"
  | "figma_import_failed"
  | "figma_import_applied"
  // Sites - version history (Path C Phase 3)
  // Unified timeline over instinct_site_brief_generations +
  // instinct_site_brief_edits. Restore is the strong signal: clients whose
  // designers roll back often = brittle edit / extraction patterns that
  // the learning loop flags for tuning.
  //   site.version_history_viewed: { site_id, version_count }
  //   site.version_diff_viewed:    { site_id, version_id, field_changes }
  //     - field count so the learning loop can distill typical diff
  //       sizes per client
  //   site.version_restored:       { site_id, from_version_id,
  //                                  to_version_id, field_changes }
  //     - restore is a strong signal that something went wrong; the
  //       learning loop uses this to flag brittle edit patterns
  | "site.version_history_viewed"
  | "site.version_diff_viewed"
  | "site.version_restored"
  // Sites - editor-vs-live parity diagnostic. Fired by the editor detail
  // page right after the preview iframe mounts with both a deployed URL
  // and an in-memory draft, so the learning loop can track how often
  // designers are likely seeing a drift between the two surfaces.
  //   sites.editor_preview_parity_check: { site_id, source, has_preview_url }
  | "sites.editor_preview_parity_check"
  // Sites - section comments (Path C Phase 3 · Stream R3)
  //
  // Threaded per-section review comments. Two posting paths: unauth
  // share-link reviewers (via_share_token=true) and authed designers
  // (via_share_token=false). Metadata shapes:
  //
  //   site.comment_posted:   { site_id, via_share_token, page_index,
  //                            section_index, section_type, body_length,
  //                            has_actor_email }
  //     - body_length is the raw trimmed length; body itself is NEVER
  //       in analytics (client text may contain business PII).
  //
  //   site.comment_resolved: { site_id, comment_id, resolved_by_role }
  //     - resolve RATE (resolved ÷ posted per site) is THE KPI for this
  //       feature. A high rate = healthy client feedback loop. A low
  //       rate = comments are piling up unread, signal for the learning
  //       loop to flag the client relationship.
  //
  //   site.comment_replied:  { site_id, parent_comment_id }
  //     - thread depth tracking. Deep threads = nuanced feedback; shallow
  //       threads = quick single-shot comments.
  //
  //   site.comment_deleted:  { site_id, comment_id, deleted_by_role }
  //     - deletes are SOFT (body tombstoned in DB); the row survives so
  //       the audit trail stays intact. deleted_by_role tells ops
  //       whether client-side tools are deleting too aggressively.
  | "site.comment_posted"
  | "site.comment_resolved"
  | "site.comment_replied"
  | "site.comment_deleted"
  // Sites - direct-manipulation canvas (Path C Phase 4 · Stream U2)
  //
  // Designer toggles the canvas into direct-edit mode and drives section
  // and field changes by clicking directly on the preview - no prompt,
  // no sidebar. Each of the six events feeds the learning loop with a
  // distinct signal:
  //
  //   direct_edit.enabled / direct_edit.disabled
  //     - raw adoption signal; what % of edit sessions use direct-edit
  //       vs. prompt-only. Low adoption = discoverability problem on the
  //       toggle chrome; high adoption = we should invest in the flow.
  //   direct_edit.element_clicked (metadata: element_type)
  //     - which element types designers REACH for first. If everyone
  //       clicks headings but never CTAs, the CTA toolbar is buried.
  //   direct_edit.text_committed (metadata: section_id, field)
  //     - committed inline text edits. Feeds same learning loop as
  //       `site.inline_text_edited` but scoped to the canvas UX so we
  //       can compare prompt-driven vs direct-manipulation quality.
  //   direct_edit.cta_committed (metadata: section_id)
  //     - CTA label/href changes from the floating toolbar.
  //   direct_edit.section_reordered_via_canvas (metadata: from_idx, to_idx)
  //     - parallels `site.section_reordered` but distinguishes
  //       toolbar-arrow usage from drag-handle usage. Designer
  //       preference here drives future UX investment.
  | "direct_edit.enabled"
  | "direct_edit.disabled"
  | "direct_edit.element_clicked"
  | "direct_edit.text_committed"
  | "direct_edit.cta_committed"
  | "direct_edit.section_reordered_via_canvas"
  // Sites - offline mode (Path C - site editor resiliency). The editor
  // persists failed mutations to IndexedDB and replays on reconnect.
  // Metadata shapes:
  //   offline.detected:                  {}
  //     - fires once when navigator goes offline with editor open.
  //   offline.returned_online:           { queue_size }
  //     - fires at the top of flushQueue so we see inbound-replay
  //       burst size per user session.
  //   offline.mutation_queued:           { endpoint, method }
  //   offline.mutation_replayed:         { endpoint, success }
  //   offline.mutation_replay_failed:    { endpoint, error, attempt }
  //     - retry counter so the learning loop can see which endpoints
  //       are flaky vs. which are terminal (auth, validation).
  //   offline.brief_served_from_cache:   { site_id, cache_age_ms }
  //     - cold-load from cache actually unblocked a designer (KPI).
  //   offline.resource_served_from_cache:
  //     { resource_type, resource_id, cache_age_ms }
  //     - Stream U4 generalization of brief_served_from_cache. Fires
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
  // RAG offline cache (Path C - Stream U5)
  //
  // Reusable primitive sitting on top of offline-cache.ts that stashes
  // RAG query+answer+sources snapshots so assistant / brain / knowledge
  // flows survive a cold-load while the user is offline. Keys by
  // normalized query fingerprint; falls back to Jaccard fuzzy match on
  // the tokenized query when no exact hit exists. Metadata shapes:
  //
  //   rag.result_cached       { scope, query_token_count, doc_count }
  //     - `scope` is the RAG sub-scope ("assistant" | "brain" |
  //       "knowledge" | caller-defined string). `query_token_count` is
  //       post-stopword-strip so the learning loop can see how much
  //       signal the query carried. `doc_count` is retrieved_docs.length
  //       so we can distill per-scope the typical breadth of a hit.
  //
  //   rag.served_from_cache   { scope, similarity, is_fuzzy,
  //                             cache_age_ms }
  //     - fires on cache hit (exact OR fuzzy). `similarity` ∈ [0,1],
  //       Jaccard on tokens. `is_fuzzy=false` implies similarity===1.
  //       The learning loop watches `is_fuzzy` rate - too many fuzzy
  //       hits means the fingerprint is underspecified (stopword list
  //       may need trimming) or the scope has too few cached queries.
  //
  //   rag.cache_miss_offline  { scope }
  //     - offline read path found no cached match (exact or fuzzy).
  //       The user is about to see an empty RAG state; this is the
  //       clearest signal of a coverage gap for that scope.
  //
  //   rag.cache_evicted       { scope, count }
  //     - fires on every eviction sweep. `count` is the number of rows
  //       dropped. High frequency here = the per-scope cap is too
  //       aggressive for the traffic pattern.
  | "rag.result_cached"
  | "rag.served_from_cache"
  | "rag.cache_miss_offline"
  | "rag.cache_evicted"
  // RAG ambient doc-body backfill (Path C - Stream U5 follow-up).
  //
  // When any of the 3 RAG wrappers (assistant / brain / knowledge)
  // successfully caches a fresh online response, we silently fire
  // background fetches for the top-K source doc bodies and stash them
  // in the generic resource cache under resource_type="doc_body" so
  // that if the user taps a source offline we can show the full text.
  // This is pure infrastructure - no UI surface. The four events below
  // let the learning loop see how often backfill runs, how much it
  // hydrates, and where it has coverage gaps.
  //
  //   rag.doc_backfill_scheduled { scope, source_count, top_k }
  //     - scheduleDocBodyBackfill() was invoked by a wrapper. Fires
  //       ONCE per wrapper success, BEFORE any network work starts.
  //       source_count = raw sources length, top_k = how many we will
  //       actually attempt after truncation.
  //
  //   rag.doc_backfilled { scope, doc_id, bytes }
  //     - one doc body was fetched + cached successfully. `bytes` is
  //       approx byte length of the cached `content` string so the
  //       learning loop can detect pathological payloads.
  //
  //   rag.doc_backfill_skipped { scope, doc_id, reason }
  //     - one doc body fetch was skipped or failed. `reason` ∈
  //       { "recent_cache_hit" | "no_endpoint" | "fetch_failed"
  //         | "timeout" }. High `no_endpoint` rates on a scope mean we
  //       should ship a doc-body route for that scope.
  //
  //   rag.doc_backfill_completed { scope, attempted, cached, skipped,
  //                                 failed, duration_ms }
  //     - fires when a single scheduled backfill batch finishes. Useful
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
  //     - fired once at the start of each runSessionWarmPass(). scope_count
  //       is the number of scopes the pass will iterate (currently 3).
  //
  //   ambient.warm_pass_completed   { scope, attempted, refreshed, failed,
  //                                   duration_ms }
  //     - one per scope once that scope's iteration finishes (or is
  //       aborted). attempted/refreshed/failed let dashboards surface how
  //       effective the pass is per scope so we can tune topN + delay.
  //
  //   ambient.idle_detected         { idle_ms }
  //     - the user has been idle for idle_ms (≥ idleThresholdMs). Fires
  //       every time the idle watcher ticks; high frequency + low
  //       refresh rate suggests the user lingers but doesn't interact.
  //
  //   ambient.idle_refresh_fired    { scope, cache_age_ms_before,
  //                                   cache_age_ms_after }
  //     - a stalest-entry refresh succeeded. cache_age_ms_after is the
  //       age right after the refresh write (typically 0).
  //
  //   ambient.idle_refresh_skipped  { reason }
  //     - idle refresh was deliberately suppressed. reason ∈
  //       {"offline","save_data","no_stale_entries","max_refreshes_reached"}
  //       - lets us slice by cause (bandwidth preference vs cap vs
  //       nothing stale) when looking at refresh-churn telemetry.
  | "ambient.warm_pass_started"
  | "ambient.warm_pass_completed"
  | "ambient.idle_detected"
  | "ambient.idle_refresh_fired"
  | "ambient.idle_refresh_skipped"
  | "pwa.install_prompt_shown"
  | "pwa.install_prompt_dismissed"
  | "pwa.installed"
  // Sites - unified studio shell (Path C Phase 4 · Stream U1)
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
  //     - tab_name ∈ {"chat","sections","theme","assets","seo","forms",
  //                   "domain","share","versions","comments"}
  //   studio.section_selected:        { site_id, section_id }
  //     - section_id is "<index>:<type>" so analytics queries can
  //       group by section type without requiring a join to the brief.
  //   studio.section_reordered:       { site_id, from_idx, to_idx }
  //   studio.section_duplicated:      { site_id, section_id }
  //   studio.section_deleted:         { site_id, section_id }
  //   studio.section_added:           { site_id, section_type }
  //   studio.inspector_field_edited:  { site_id, field_path, section_id }
  //     - field_path is slash-delimited (e.g. "heading", "cta/label").
  //   studio.publish_clicked:         { site_id, pending_edit_count }
  //     - publish was clicked; server-side save+deploy runs separately.
  | "studio.opened"
  | "studio.tab_changed"
  | "studio.section_selected"
  | "studio.section_reordered"
  | "studio.section_duplicated"
  | "studio.section_deleted"
  | "studio.section_added"
  | "studio.inspector_field_edited"
  | "studio.publish_clicked"
  // RAG provider abstraction - vector/graph/embedding telemetry.
  //
  // Every event is fired fire-and-forget by the provider-abstraction
  // layer (`src/lib/rag-providers/*`). These feed the learning loop so
  // the ML pipeline can learn from every RAG operation and every
  // divergence between stores during the Azure migration.
  //
  //   rag.vector_provider_selected    { provider }
  //     - boot-time: which vector backend the factory resolved to.
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
  // MS Teams chat / presence / deep-link integration (Phase 1 - read-only).
  //
  //   ms_chats.listed              { count }
  //     - `/me/chats` returned `count` chats.
  //   ms_chats.messages_loaded     { chat_id, count }
  //     - `/me/chats/{id}/messages` returned `count` messages.
  //   ms_chats.scope_missing       {}
  //     - Graph returned 401/403 for chats; caller should prompt re-consent
  //       for `Chat.Read`.
  //   ms_presence.batch_fetched    { count }
  //     - batched `/me/presences` or per-user presence fetch resolved
  //       `count` user presences.
  //   ms_presence.scope_missing    {}
  //     - Graph returned 401/403 for presence; caller should prompt
  //       re-consent for `Presence.Read`.
  //   ms_deep_link.generated       { type }
  //     - a Teams deep-link URL was generated. `type` ∈
  //       "chat" | "call" | "meet_now".
  //   ms_chats.message_sent        { chat_id, length }
  //     - inline compose succeeded against `/me/chats/{id}/messages`.
  //       `length` is the final body character count POSTed (post-
  //       sanitization). Fired from the server-side lib on Graph 201.
  //   ms_chats.write_disabled      { user_id }
  //     - POST /api/ms/chats/[id]/messages rejected because the
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
  // Messages inline-compose (Phase 1.5 - Teams write path).
  //
  // The /messages page now hosts an inline composer that POSTs to
  // /api/ms/chats/[id]/messages instead of punting every user to the
  // Teams desktop client via deep-link. These events let the learning
  // loop grade inline-compose adoption, failure mode distribution, and
  // permission-gate friction.
  //
  //   messages.compose_sent          { chat_id, length }
  //     - fires on a 200 server response. `length` is the trimmed body
  //       length so the brain can distil typical message size per user
  //       / per chat without storing the body itself (privacy).
  //
  //   messages.compose_failed        { chat_id, reason }
  //     - every non-success path. `reason` ∈ {"scope_missing",
  //       "write_disabled","network","http_<status>"}. Distinct from
  //       compose_sent so the failure rate is trivially computable.
  //
  //   messages.scope_prompt_shown    { chat_id }
  //     - the inline "Grant Chat.ReadWrite to send from here" hint was
  //       surfaced. Fires once per render of the prompt. High rate ⇒
  //       too many users have Read-only scope; nudge the settings flow.
  //
  //   messages.write_disabled_shown  { chat_id }
  //     - the workspace flag `inline_teams_write` is off. Fires when
  //       the inline hint surfaces pointing users at the Reply-in-Teams
  //       deep-link. High rate ⇒ a workspace owner disabled the flag;
  //       lets Agent A's flag roll-out track churn.
  | "messages.compose_sent"
  | "messages.compose_failed"
  | "messages.scope_prompt_shown"
  | "messages.write_disabled_shown"
  // Cross-page Teams unread badge (top-nav) - lets the learning loop
  // size how often the badge polls, how often users engage with it,
  // and how "fresh" Teams activity maps to user attention.
  //
  //   messages.unread_count_polled   { count }
  //     - fires server-side on every GET /api/ms/chats/unread-count
  //       that resolves (including scope_missing and not-connected
  //       paths). `count` is the number of chats newer than the
  //       client-provided `since` timestamp; 0 when absent or none.
  //
  //   messages.unread_badge_clicked  { count }
  //     - fires client-side when the user clicks the badge to jump to
  //       /messages. `count` is the value shown at click time so we
  //       can distinguish "zero-badge tap" (shouldn't happen, badge is
  //       hidden) from "dismissed N unread".
  | "messages.unread_count_polled"
  | "messages.unread_badge_clicked"
  // /messages left-panel structure - collapsible Chats section + new
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
  // AI smart-compose / draft-reply - fires across chat, channel, and
  // email composers. The acceptance/modification rate per surface is
  // a high-quality training signal: it tells us where AI drafts land
  // closest to what the user actually sends, and where they're so
  // off the user starts from scratch.
  //
  //   assistant.draft_requested   { surface, context_id?, had_draft_so_far,
  //                                 thread_turns, model, prompt_tokens,
  //                                 completion_tokens }
  //   assistant.draft_accepted    { surface, context_id?, edit_distance,
  //                                 sent_length }   - fires on send if
  //                                 user sent within 5min of the draft
  //   assistant.draft_modified    { surface, context_id?, edit_distance,
  //                                 sent_length }   - fires when sent text
  //                                 differs significantly from draft
  //   assistant.draft_discarded   { surface, context_id? }
  //                                 - fires when user clears the draft
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
  //     - fires on send when message contained at least one mention
  | "ms_chats.mentions_sent"
  | "messages.mention_added"
  | "messages.mention_completed"
  // Bug-fix bundle 2026-04-29: empty-bubble renderer + read-state +
  // notification deep-link. Each event feeds a specific learning loop:
  //
  //   messages.system_event_rendered     { subtype }
  //     fires every time SystemEventPill renders. `subtype` is the
  //     normalized Graph subtype (callEnded, membersAdded, …) so the
  //     learning loop can rank the most-common subtypes and tell us
  //     which renderers to invest in next. "unknown" buckets every
  //     subtype the renderer hasn't been taught yet.
  //
  //   messages.attachment_summary_rendered  { attachment_kind }
  //     fires every time AttachmentSummaryPill renders an attachment-
  //     only message. `attachment_kind` is the Graph contentType
  //     (adaptive card, file reference, meeting card, etc.) so the
  //     learning loop can prioritize first-class previews for the
  //     most-common kinds.
  //
  //   messages.read_state_advanced       { chat_id, kind }
  //     fires server-side when the read-state lib upserts a row.
  //     `kind` ∈ "chat" | "channel" | "team" - same table backs all
  //     three surfaces, this metadata lets the dashboard split them.
  //
  //   messages.deep_link_landed          { chat_id, message_id, scroll_succeeded }
  //     fires client-side after the page consumes
  //     `?chat=…&message=…`. `scroll_succeeded` distinguishes "the
  //     target message was in the loaded thread" from "we opened the
  //     chat but couldn't find the row" so we can size notification
  //     deep-link UX.
  | "messages.system_event_rendered"
  | "messages.attachment_summary_rendered"
  | "messages.read_state_advanced"
  | "messages.deep_link_landed"
  // Automations - modular workflow surface. Stream A (porsche-classes)
  // is the first concrete automation. Every meaningful ingest and human
  // intervention emits one of these so the learning loop can see how
  // many manual overrides land per artifact, which automations have the
  // worst parse precision, and which exception kinds pile up unactioned.
  //
  //   automations.artifact_ingested   { automation_id, source_type,
  //                                      source_message_id, classes }
  //     - fires after a successful parse + persist. `classes` is the
  //       count of distinct class_keys observed in this artifact.
  //
  //   automations.artifact_quarantined { automation_id, source_message_id,
  //                                        reason, exception_kind }
  //     - fires when a parser returns ParseFailure; the artifact moves
  //       to error_quarantined and an exception row is created.
  //
  //   automations.delta_computed       { automation_id, class_key,
  //                                        added, dropped, is_baseline }
  //     - fires on every delta row insert (including baselines).
  //
  //   automations.override_applied     { automation_id, kind }
  //     - fires when Alicia (or a teammate) records a manual override.
  //
  //   automations.exception_resolved   { automation_id, kind,
  //                                        outcome }   outcome=resolved|dismissed
  //
  //   automations.poll_run             { automation_id, new_artifacts,
  //                                        duration_ms }
  //     - one inbox-poller cycle finished; new_artifacts is how many
  //       fresh items were ingested this tick.
  | "automations.artifact_ingested"
  | "automations.artifact_quarantined"
  | "automations.delta_computed"
  | "automations.override_applied"
  | "automations.exception_resolved"
  | "automations.poll_run"
  | "automations.poll_historical"
  | "automations.poll_skipped"
  //   automations.poll_started        { automation_id, mode, mailbox_count }
  //   automations.poll_completed      { automation_id, messages_seen,
  //                                       messages_matched, artifacts_ingested,
  //                                       artifacts_duplicate, artifacts_quarantined,
  //                                       errors, duration_ms }
  //     - bookend events to poll_run; lets the learning loop see how
  //       long a tick took and what the inbound mix looks like.
  //   automations.artifact_deduplicated { automation_id, source_type,
  //                                         source_message_id, dedup_strategy }
  //     - fires when ingestArtifact short-circuits an already-processed
  //       artifact. dedup_strategy ∈ "internet_message_id" | "fallback_hash".
  //   automations.parse_failure       { automation_id, source_type,
  //                                       missing_columns, exception_kind, hint }
  //     - emitted by parsers when a known-shape input rejects. The
  //       missing_columns list names the SPECIFIC canonical column(s)
  //       that were absent so the operator + learning loop know whether
  //       the parser needs a new synonym or the source is malformed.
  //   automations.quarantine_reprocessed { automation_id, exception_id,
  //                                          artifact_id, outcome }
  //     - fires when an operator clicks "Reprocess" on a quarantined
  //       artifact. outcome ∈ "processed" | "still_quarantined" | "duplicate".
  | "automations.poll_started"
  | "automations.poll_completed"
  | "automations.artifact_deduplicated"
  | "automations.parse_failure"
  | "automations.quarantine_reprocessed"
  //
  //   automations.cursor_advanced     { automation_id, mailbox_base,
  //                                      cursor_kind, ms_since_last_poll }
  //     - fires every time the inbox poller writes a new cursor for
  //       (automation_id, user_id, mailbox_base). cursor_kind is
  //       "delta" | "search" so the learning loop can tell which Graph
  //       access mode is running. ms_since_last_poll is the elapsed time
  //       since the previous successful cursor write for THIS mailbox
  //       base (null on first write); over time the system can detect a
  //       stalled mailbox by watching this drift past the cron interval.
  //       Empty mailbox_base ('') represents the legacy default mailbox.
  | "automations.cursor_advanced"
  // Meeting Insights - multi-feed recurring-meeting ingest (Stream A).
  //
  //   automations.feed_created      { automation_id, feed_id, feed_slug,
  //                                    sender_match_count, subject_match_count }
  //     - admin created a new feed; the sender/subject counts let
  //       dashboards spot pathological catch-all feeds early.
  //
  //   automations.feed_updated      { automation_id, feed_id, feed_slug,
  //                                    fields }   fields=comma-joined
  //     - any patch to name / description / filters / is_enabled.
  //
  //   automations.feed_disabled     { automation_id, feed_id, feed_slug }
  //     - soft-delete (is_enabled=false). History is preserved.
  //
  //   automations.feed_poll_triggered { automation_id, feed_id, feed_slug,
  //                                     messages_seen, messages_matched,
  //                                     artifacts_ingested, errors }
  //     - operator hit the "Run now" button on a feed. The poll under
  //       the hood is still automation-wide (one Graph cursor) but the
  //       event records which feed asked.
  | "automations.feed_created"
  | "automations.feed_updated"
  | "automations.feed_disabled"
  | "automations.feed_poll_triggered"
  // Meeting Insights - Phase 2 analyzer + Phase 3 themes events.
  //
  //   automations.message_analyzed   { automation_id, feed_id, feed_slug,
  //                                     message_id, analyzer_version,
  //                                     status, topics, decisions,
  //                                     action_items, tokens_used,
  //                                     triggered_by? }
  //     - fired after every analyzer pass (success | partial | error).
  //       triggered_by="manual" when the operator hit "Re-analyze".
  //
  //   automations.message_reanalyze_requested { automation_id, feed_id,
  //                                              feed_slug, message_id,
  //                                              prior_status }
  //     - operator clicked "Re-analyze" on a message detail page.
  //
  //   automations.themes_viewed     { automation_id, feed_id, feed_slug,
  //                                    recurring, stale, open_action_items }
  //     - themes tab page-view; counts so we can see whether the page
  //       is actually surfacing signal.
  //
  //   automations.themes_searched   { automation_id, feed_id, feed_slug,
  //                                    query_length, hit_count }
  //     - semantic search executed. query_length only (no q text) so
  //       we don't leak meeting content into the events stream.
  | "automations.message_analyzed"
  | "automations.message_reanalyze_requested"
  | "automations.themes_viewed"
  | "automations.themes_searched"
  // Porsche-classes summary export - Alicia's manual workflow today is
  // "download summary → drop into PCNA SharePoint folder". The
  // /summaries/[classKey]/upload-sharepoint route automates the drop and
  // emits one event per attempt so we can prove the automation
  // (a) ran for the right class, and (b) when it gracefully degraded
  // (skipped_reason captures why - not_configured / no_token /
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
  // (/automations/porsche-classes/setup) - non-technical operators
  // configure ingest mailbox filters + SharePoint destination without
  // touching env vars. Events fire from
  // /api/automations/porsche-classes/config and /sharepoint-test.
  //
  //   automations.config_viewed       { automation_id }
  //     - operator opened the wizard and the GET /config call returned.
  //
  //   automations.config_updated      { automation_id, fields }
  //     - operator saved a new config row. fields=comma-joined list of
  //       which payloads changed (inbox_filters / sharepoint).
  //
  //   automations.sharepoint_test_run { automation_id, ok, status? }
  //     - sharepoint-test endpoint hit Graph; ok=true on a 2xx folder
  //       lookup, false otherwise.
  | "automations.config_viewed"
  | "automations.config_updated"
  | "automations.sharepoint_test_run"
  // Support - operator-driven shared-mailbox ticket flow.
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
  //     - emitted on every inbox-poller tick (cron + operator Run-now).
  //       Used to monitor poll cadence and catch token expiry early.
  //
  //   support.categorized        { ticket_id, category, confidence, source }
  //     - emitted by the AI auto-categorizer (manual create + email
  //       ingest). Used by the learning loop to compute classifier
  //       precision over time and surface which buckets the model
  //       struggles with.
  //
  //   support.auto_acknowledged  { ticket_id, pattern_id, char_count,
  //                                latency_ms }
  //     - emitted when the auto-ack pipeline successfully sent a reply
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
  //     - emitted whenever the operator opens /support/patterns. Lets
  //       us measure how often operators inspect the pattern library
  //       and how many patterns currently have auto-ack opted in.
  //
  //   support.pattern_updated   { pattern_id, pattern_slug,
  //                               fields_changed, auto_acknowledge_enabled }
  //     - emitted on every successful PATCH /api/support/patterns/[id].
  //       The learning loop joins this stream against ticket outcomes
  //       to score auto-ack opt-in choices over time.
  | "support.patterns_viewed"
  | "support.pattern_updated"
  // Persistent AI response cache (src/lib/ai/response-cache).
  //
  //   support.cache_hit  { feature, cache_id, tokens_saved }
  //     - emitted whenever lookupCachedResponse returns a hit. `feature`
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
  //     - `window` is one of 'today' | '7d' | '30d' | 'all'.
  | "support.analytics_viewed"
  // AI provider abstraction (src/lib/ai). Emitted on every model call so
  // we can attribute spend per feature, watch latency, and detect when
  // the failover path is firing.
  //
  //   ai.completion { feature, provider, model, tier, input_tokens,
  //                   output_tokens, cost_usd, latency_ms, fallback_used,
  //                   sensitivity? }
  | "ai.completion"
  // Assistant context resolver (src/lib/assistant/context-resolver.ts).
  // Combines SharePoint search hits + MS Project / Planner / To Do tasks
  // into a single prompt block injected into the LLM call so answers
  // stay grounded in the team's content rather than the model's training
  // data. Together with `support.cache_hit`, the two streams give a full
  // picture of how grounded the assistant is.
  //
  //   assistant.context_resolved   { surface, sharepoint_count,
  //                                  project_count, total_chars, took_ms }
  //     - surface is "knowledge" | "assistant_support". Fired whenever
  //       getRelevantContext runs (including empty results) so the
  //       learning loop can score "did context help?" against the
  //       answer-feedback stream the cache agent owns.
  //
  //   assistant.context_truncated  { surface, dropped_count, reason,
  //                                  dropped_sharepoint, dropped_project }
  //     - reason is currently always "max_chars". Fires when entries had
  //       to be dropped to fit `maxChars` (default 6000). High rates
  //       here signal we should raise the budget or improve relevance
  //       ranking before injection.
  //
  //   assistant.sharepoint_lookup_failed  { status, scope_missing, code }
  //   assistant.project_lookup_failed     { status, scope_missing, code }
  //     - One per failed surface. `scope_missing` is true when Graph
  //       returned 403 with an authorization error code. Used to drive
  //       the "Reconnect Microsoft 365" banner in the assistant UI.
  //
  //   assistant.meeting_lookup_failed     { status, scope_missing }
  //     - Fired when the meeting-transcripts surface fails (Plaud/DB
  //       errored, query parse failed, etc.). Mirrors the SharePoint /
  //       Project failure events so the same dashboard can show all
  //       three context surfaces side-by-side.
  //
  //   assistant.calendar_lookup_failed    { status, scope_missing, code }
  //   assistant.email_lookup_failed       { status, scope_missing, code }
  //     - One per failed Outlook surface (calendar, mail). `scope_missing`
  //       is true when Graph returned 403 with an authorization error
  //       code (e.g. user revoked Calendars.Read or Mail.Read). Used to
  //       drive the same "Reconnect Microsoft 365" banner.
  //
  //   assistant.knowledge_cache_bypassed  { reason }
  //     - Fired when the assistant intentionally skips the knowledge
  //       cache lookup (e.g. date-bound or meeting-bound questions).
  //       Cache hit-rate is already tracked. This event closes the
  //       loop so we can see how often the cache is routed around and
  //       why.
  | "assistant.context_resolved"
  | "assistant.context_truncated"
  | "assistant.sharepoint_lookup_failed"
  | "assistant.project_lookup_failed"
  | "assistant.meeting_lookup_failed"
  | "assistant.calendar_lookup_failed"
  | "assistant.email_lookup_failed"
  | "assistant.knowledge_cache_bypassed"
  /* org_qa_cache_hit: an identical normalized question by any user in
     the org was answered before (within TTL), and we served the prior
     answer at zero tokens. Drives the "tokens saved by cache" metric. */
  | "assistant.org_qa_cache_hit"
  /* qr_code_created: a wolfpack member generated a new offline QR
     code targeting an authenticated URL. Metadata captures whether a
     UTM campaign / expiry was attached + the target hostname so the
     learning loop can spot which campaigns drive scans. */
  | "assistant.qr_code_created"
  /* qr campaign deletion-lock (migration 160). locked/unlocked track
     which campaigns operators protect; archive_blocked fires when an
     Archive is refused because the campaign is locked - a signal of
     accidental-delete pressure the learning loop can surface. */
  | "qr.code_locked"
  | "qr.code_unlocked"
  | "qr.archive_blocked"
  /* survey builder (migration 161). created/updated/published/closed/
     deleted track the lifecycle an operator drives; response_submitted /
     response_rejected fire from the public responder so the learning loop
     sees completion + abuse/validation pressure. response_submitted is
     the durable signal joined to client + QR-scan attribution. */
  | "survey.created"
  | "survey.updated"
  | "survey.published"
  | "survey.closed"
  | "survey.deleted"
  | "survey.qr_linked"
  /* survey.viewed: a public responder load (migration 162). Paired with
     response_submitted it yields the view→completion funnel + drop-off
     that a form SaaS can't surface; carries device/geo/referrer/qr_scan. */
  | "survey.viewed"
  | "survey.response_submitted"
  | "survey.response_rejected"
  /* qr_scan_recorded: a public scan hit /q/[slug] and was either
     redirected (blocked=false) or short-circuited because the code
     was missing/archived/expired (blocked=true). The redirect handler
     fires this fire-and-forget - never blocks the 302. */
  | "assistant.qr_scan_recorded"
  /* qr_analytics_viewed: an authorized member opened the analytics
     dashboard for a specific QR code. Distinct from system.page_viewed
     so QR-specific drill-in is reportable. */
  | "assistant.qr_analytics_viewed"
  /* qr_scan_detail_viewed: an authorized member opened the per-scan
     attribution detail (the "View all scans" panel that surfaces every
     captured datapoint per scan, incl. client-match heuristics). Drives
     the "team is using attribution" learning-loop dashboard so we know
     whether this view is paying for the storage cost of the extended
     columns in migration 112. */
  | "assistant.qr_scan_detail_viewed"
  /* qr_code_exported: a member downloaded a QR in a given format
     (svg/png/jpg/pdf/eps). Fired fire-and-forget from the download menu
     so the learning loop sees which print/share formats the team
     actually uses - e.g. EPS demand for print houses - and no export
     signal is lost. */
  | "assistant.qr_code_exported"
  /* org_fact_captured: a user follow-up corrected a prior assistant
     answer ("no, the client is Porsche"). The correction is stored in
     instinct_org_facts and injected into all subsequent prompts whose
     question text references the same subject. Drives the "team is
     teaching the assistant" learning-loop dashboard. */
  | "assistant.org_fact_captured"
  /* page_facts is a separate static lookup that fires BEFORE the
     knowledge cache. Bypass it for the same query categories so a
     "what's in the TWA agenda doc" question doesn't get short-circuited
     to a generic "Docs page" page-facts blurb. */
  | "assistant.page_facts_bypassed"
  /* context_debug_invoked: emitted by GET /api/assistant/context-debug
     each time an authorized user inspects EXACTLY what grounding
     `getRelevantContext` returned for a question. Distinct from
     `assistant.context_resolved` (which fires inside the resolver on
     every assistant call) so triage dashboards can isolate "user is
     debugging grounding" runs from regular traffic. */
  | "assistant.context_debug_invoked"
  /* grounding_debug_invoked: emitted by GET /api/assistant/grounding-debug
     each time the /admin/assistant-debug self-service diagnostic page
     loads. Distinct from `assistant.context_debug_invoked` (which only
     reflects the resolver bundle); this event additionally captures
     whether the user's stored Microsoft token decoded, what scopes it
     carried, and whether live Graph probes succeeded. Drives "user is
     stuck on grounding" triage dashboards. */
  | "assistant.grounding_debug_invoked"
  // Bulletin boards - multi-user sticky-note board surface.
  //
  //   bulletin.board_created    { board_id, has_description }
  //     - fires when /api/bulletin/boards POST inserts a row. Drives
  //       the "boards-per-week" panel on the analytics dashboard.
  //
  //   bulletin.board_archived   { board_id }
  //     - DELETE on a board flips archived_at; the board becomes a
  //       frozen meeting artifact (read-only). Distinct from a hard
  //       delete: notes/snapshots remain queryable.
  //
  //   bulletin.note_created     { board_id, has_association, kind }
  //   bulletin.note_updated     { note_id }
  //   bulletin.note_deleted     { note_id }
  //     - sticky-note CRUD churn. has_association/kind let the learning
  //       loop see which surfaces (task/meeting/...) drive note creation.
  //
  //   bulletin.snapshot_saved   { board_id, has_association, kind }
  //   bulletin.snapshot_viewed  { snapshot_id }
  //     - snapshot lifecycle. saved is per-write; viewed fires from the
  //       PNG-streaming endpoint each time a meeting page or task surface
  //       loads its attached snapshot.
  | "bulletin.board_created"
  | "bulletin.board_archived"
  | "bulletin.note_created"
  | "bulletin.note_updated"
  | "bulletin.note_deleted"
  | "bulletin.snapshot_saved"
  | "bulletin.snapshot_viewed"
  // Portal (Salesforce widget proof-of-pattern) - full-page surface
  // reachable from the assistant. Each route fires one of these so the
  // learning loop sees which CRM views drive engagement vs the chat-only
  // path.
  //
  //   portal.salesforce_dashboard_viewed         { connector }
  //   portal.salesforce_list_viewed              { type, query_length,
  //                                                  result_count, connector }
  //   portal.salesforce_record_viewed            { type, connector }
  //   portal.salesforce_record_updated           { type, field, connector }
  //   portal.salesforce_record_created           { type, connector }
  //   portal.salesforce_quick_search             { query_length }
  | "portal.salesforce_dashboard_viewed"
  | "portal.salesforce_list_viewed"
  | "portal.salesforce_record_viewed"
  | "portal.salesforce_record_updated"
  | "portal.salesforce_record_created"
  | "portal.salesforce_quick_search"
  // Job codes - SharePoint-backed catalog (read-only). The view
  // event fires on every API hit so we can see catalog freshness vs.
  // usage. Refresh events distinguish auto-stale (TTL expired) vs
  // manual (admin clicked Refresh) vs the served-stale fallback when
  // Graph is down.
  | "jobcodes.viewed"
  | "jobcodes.searched"
  | "jobcodes.refresh_requested"
  | "jobcodes.refresh_succeeded"
  | "jobcodes.refresh_failed"
  | "jobcodes.served_stale"
  | "jobcodes.source_fetched"
  /* Cell edits to the SharePoint workbook (D/E/F columns only) -
     succeeded fires after Graph PATCH echoes the new value AND the
     cache mirror updates; failed covers every refusal class
     (forbidden_column, code_not_found, Graph 403/5xx). */
  | "jobcodes.cell_edit_succeeded"
  | "jobcodes.cell_edit_failed"
  /* Idempotent skip - the cell already held the value the user was
     about to write. Different from cell_edit_succeeded so the
     learning loop can see the "no-op rate" (high noop rate = UI
     re-saves on every blur, which means we should debounce more). */
  | "jobcodes.cell_edit_noop"
  /* Concurrency conflict - pre-write verify found the cell had been
     changed by someone else between dialog-open and submit. Fires
     once on detection (when the API returns 409) and once on
     resolution with {resolved_as: keep_theirs|overwrite|cancel}. */
  | "system.job_code_conflict_detected"
  | "system.job_code_conflict_resolved"
  /* Receipt scanning via Azure Document Intelligence - extracted
     fields can be applied to a job code's Program/PO/PO Amount via
     the existing /cell PATCH endpoint. */
  | "jobcodes.receipt_scanned"
  | "jobcodes.receipt_scan_failed"
  | "jobcodes.receipt_applied"
  /* Per-code dossier - cross-source view at /job-codes/[code] joins
     the cache row, applied receipt scans, and the audit log. Fires
     on page render so we can see which codes get drilled into most
     (informs whether to surface dossier links from other surfaces). */
  | "system.job_code_dossier_viewed"
  /* Azure Cognitive Services call telemetry - fired by lib/azure/
     audit.ts on EVERY call so the learning loop can forecast
     free-tier quota and detect failure spikes. */
  | "azure.vision_ocr_succeeded"
  | "azure.vision_ocr_failed"
  | "azure.form_recognizer_succeeded"
  | "azure.form_recognizer_failed"
  /* AP invoice queue - scan + lifecycle events. */
  | "finance.invoice_scanned"
  | "finance.invoice_scan_failed"
  | "finance.invoice_approved"
  | "finance.invoice_paid"
  | "finance.invoice_rejected"
  | "finance.invoice_updated"
  | "finance.invoice_deleted"
  /* HR scanned-docs intake. */
  | "hr.document_scanned"
  | "hr.document_scan_failed"
  | "hr.document_verified"
  | "hr.document_rejected"
  | "hr.document_updated"
  | "hr.document_deleted"
  // Cost-aware model registry + router (src/lib/ai/models/). Emitted by
  // logModelSelection() so no routing decision is ever lost. The router
  // itself stays pure (no analytics inside selectModel); callers record
  // the choice.
  //   ai.model_selected  { model_id, provider, tier, reason,
  //                        estimated_cost_usd?, fallback_from? }
  //     fires for every selectModel() result a caller decides to spend
  //     tokens on, so the learning loop can grade price/capability
  //     trade-offs and per-client/agent pins over time.
  //   ai.model_fallback  { model_id, provider, tier, reason, fallback_from }
  //     convenience event a caller may fire when a pin was unavailable
  //     or the required tier was unavailable and the router degraded.
  //     Lets dashboards count graceful degradations independently of
  //     the headline selection event.
  | "ai.model_selected"
  | "ai.model_fallback"
  // Workspace AI budget enforcement: a call refused because the workspace is over
  // its monthly_budget_usd cap (the cap was defined but previously unenforced).
  // { workspace_id, month_spend_usd, budget_usd, feature }
  | "ai.request_blocked_over_budget"
  // Per-client GitHub App credential resolution (replaces the shared PAT for
  // client repos). { workspace_id, installation_id } / removed { workspace_id }
  | "platform.github_installation_linked"
  | "platform.github_installation_removed"
  // Client offboarding: full data purge across Postgres + Qdrant + Neo4j.
  // { workspace_id, purged_findings, purged_scans, purged_targets, purged_credentials }
  | "platform.workspace_offboarded";

export interface InstinctEvent {
  event_type: InstinctEventType;
  user_id: string;
  user_role: string;
  metadata: Record<string, string | number | boolean>;
  timestamp?: string;
}

/**
 * Track an event. Fire-and-forget - never blocks, never throws.
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
