/**
 * AUDIT_ALLOWLIST
 *
 * Routes that intentionally do NOT call `recordAudit`. Every other mutation
 * route (POST / PUT / PATCH / DELETE) MUST import `recordAudit` from
 * `@/lib/audit-log` or `audit-coverage.test.ts` will fail.
 *
 * An entry belongs here if ANY of the following apply:
 *   - High-volume observability sink (analytics, CSP reports, webhooks)
 *     where per-event audit rows would flood the log without compliance value.
 *   - Read-only-by-effect despite using POST (e.g. a report generator that
 *     only returns data; no state change).
 *   - Delegated to a downstream library that already audits internally.
 *   - Owned by a concurrent stream (Tasks, Notifications, Capability).
 *     These streams add their own audit calls in their own PRs.
 *   - Public webhook from external system (signature-verified, not a
 *     user-initiated action — but the DOWNSTREAM mutation still audits).
 *
 * Reason strings are for the audit trail ABOUT this allowlist. Keep them
 * specific; reviewers will read them.
 */

export interface AuditAllowlistEntry {
  /** Route file relative to repo root, with forward slashes. */
  route: string;
  reason: string;
}

export const AUDIT_ALLOWLIST: ReadonlyArray<AuditAllowlistEntry> = [
  // High-volume observability
  {
    route: "src/app/api/analytics/route.ts",
    reason: "analytics events are the observability sink — auditing every event would flood the log",
  },
  {
    route: "src/app/api/csp-report/route.ts",
    reason: "browser-emitted CSP violation reports, thousands per day, observability only",
  },

  // Webhooks (external systems; not user-initiated)
  {
    route: "src/app/api/sites/webhook/route.ts",
    reason: "signed webhook from site-template CI; audit happens on the internal state change it triggers",
  },
  {
    route: "src/app/api/integrations/plaud/webhook/route.ts",
    reason: "signed Plaud webhook; audit happens downstream when transcripts are ingested",
  },
  {
    route: "src/app/api/tasks/webhook/route.ts",
    reason: "MS Tasks webhook — owned by Tasks stream; they add their own audit",
  },
  {
    route: "src/app/api/tasks/sync/route.ts",
    reason: "MS Tasks sync — owned by Tasks stream",
  },

  // Owned by concurrent streams
  {
    route: "src/app/api/tasks/route.ts",
    reason: "MS Tasks stream owns this and adds its own audit in its PR",
  },
  {
    route: "src/app/api/tasks/[id]/route.ts",
    reason: "MS Tasks stream owns this",
  },
  {
    route: "src/app/api/tasks/[id]/complete/route.ts",
    reason: "MS Tasks stream owns this",
  },

  // Non-state-changing POSTs (report generators, analyzers)
  {
    route: "src/app/api/assistant/route.ts",
    reason: "chat completion — no persistent state change audit-worthy; analytics already tracks",
  },
  {
    route: "src/app/api/features/[id]/analyze/route.ts",
    reason: "read-only analysis — produces a report, doesn't mutate feature state",
  },
  {
    route: "src/app/api/sites/parse-brief/route.ts",
    reason: "pure parser — doesn't persist; returns parsed JSON",
  },
  {
    route: "src/app/api/reports/route.ts",
    reason: "report generator — read-only; generates document, does not mutate source data",
  },
  {
    route: "src/app/api/reports/[id]/route.ts",
    reason: "report fetch — GET-equivalent with dynamic id",
  },

  // Knowledge / journal / feature vote — low-sensitivity UGC handled by analytics
  {
    route: "src/app/api/journal/route.ts",
    reason: "personal journal entries — user content, analytics-tracked; no PII/compliance concern",
  },
  {
    route: "src/app/api/knowledge/route.ts",
    reason: "knowledge base entries — public-within-team UGC, analytics-tracked",
  },
  {
    route: "src/app/api/knowledge/[id]/rate/route.ts",
    reason: "rating action — low-sensitivity feedback signal",
  },
  {
    route: "src/app/api/features/route.ts",
    reason: "feature requests — low-sensitivity UGC with analytics",
  },
  {
    route: "src/app/api/features/[id]/route.ts",
    reason: "feature request edit — low-sensitivity UGC",
  },
  {
    route: "src/app/api/features/[id]/vote/route.ts",
    reason: "upvote action — low-sensitivity",
  },
  {
    route: "src/app/api/discussions/route.ts",
    reason: "discussion threads — low-sensitivity UGC, analytics-tracked",
  },
  {
    route: "src/app/api/discussions/[id]/route.ts",
    reason: "discussion edit — low-sensitivity UGC",
  },
  {
    route: "src/app/api/discussions/[id]/resolve/route.ts",
    reason: "discussion resolve — low-sensitivity",
  },
  {
    route: "src/app/api/docs/route.ts",
    reason: "doc generator — produces markdown, not a compliance-relevant mutation",
  },
  {
    route: "src/app/api/docs/[id]/route.ts",
    reason: "doc editor — internal docs, low-sensitivity",
  },
  {
    route: "src/app/api/emails/route.ts",
    reason: "email drafter — produces text, no send action here",
  },
  {
    route: "src/app/api/emails/[templateId]/route.ts",
    reason: "email template fetch + draft — no outbound send audit here",
  },
  {
    route: "src/app/api/emails/[id]/route.ts",
    reason:
      "PATCH/DELETE inbox surface — archiveMessage + deleteMessage in src/lib/integrations/microsoft-mail.ts audit via mail.archived / mail.deleted",
  },
  {
    route: "src/app/api/emails/[id]/reply/route.ts",
    reason:
      "reply / replyAll / forward — replyToMessage / replyAllToMessage / forwardMessage in src/lib/integrations/microsoft-mail.ts audit via mail.replied",
  },
  {
    route: "src/app/api/emails/inbox/route.ts",
    reason: "GET-only inbox listing — no mutation; trackEvent system.ms_mail_listed only",
  },
  {
    route: "src/app/api/email-signatures/route.ts",
    reason:
      "per-user signature CRUD scoped by JWT user.id. POST fires microsoft.signature_created analytics with signature_id + is_default + body_length — that event IS the audit trail. Signatures are personal preferences (no PII/compliance concern); same low-sensitivity-UGC rationale as journal/knowledge/feature-requests above.",
  },
  {
    route: "src/app/api/email-signatures/[id]/route.ts",
    reason:
      "PATCH/DELETE delegate to lib/email-signatures.ts which scopes every write by user_id. The composer-side microsoft.signature_inserted insight + the row's updated_at column form the audit ledger; PATCH-on-default-promotion is wrapped in a SQL transaction with a partial-unique index guarantee.",
  },
  {
    route: "src/app/api/clients/route.ts",
    reason: "client CRM — analytics-tracked; no PII/compliance per current requirements",
  },
  {
    route: "src/app/api/clients/[id]/route.ts",
    reason: "client edit — same as above",
  },
  {
    route: "src/app/api/sites/route.ts",
    reason: "sites provisioning — heavy analytics; not HR/finance/auth — not audit-worthy per current scope",
  },
  {
    route: "src/app/api/sites/[id]/route.ts",
    reason: "site edit — same",
  },
  {
    route: "src/app/api/sites/[id]/assets/route.ts",
    reason: "site asset upload — same",
  },
  {
    route: "src/app/api/sites/[id]/brief-edit/route.ts",
    reason: "AI-proposed patch generation — the actual brief save (on accept) is audited by PATCH /api/sites/[id]. Every attempt still persists to apex_site_brief_edits for the learning loop.",
  },
  {
    route: "src/app/api/sites/[id]/brief-edit/[editId]/route.ts",
    reason: "user accept/reject decision on a proposed patch — recorded to apex_site_brief_edits for training; no state change outside that audit table.",
  },

  // Notifications stream (concurrent PR)
  {
    route: "src/app/api/notifications/[id]/click/route.ts",
    reason: "Notifications stream owns this — they add their own audit",
  },
  {
    route: "src/app/api/notifications/[id]/dismiss/route.ts",
    reason: "Notifications stream owns this",
  },
  {
    route: "src/app/api/notifications/[id]/read/route.ts",
    reason: "Notifications stream owns this",
  },
  {
    route: "src/app/api/notifications/mark-all-read/route.ts",
    reason: "Notifications stream owns this",
  },
  {
    route: "src/app/api/notifications/preferences/route.ts",
    reason: "Notifications stream owns this — preference change; they will audit role/pref changes in their PR",
  },
  {
    route: "src/app/api/notifications/test/route.ts",
    reason: "Notifications stream owns this — diagnostic test endpoint",
  },
  {
    route: "src/app/api/admin/notifications/trigger-digest/route.ts",
    reason: "Notifications stream owns this — admin digest trigger",
  },

  // Capability / RBAC stream (concurrent PR). Role and capability changes
  // are high-sensitivity compliance events; that stream is adding audit
  // calls as part of its own enforcement work.
  {
    route: "src/app/api/admin/users/[id]/role/route.ts",
    reason: "Capability/RBAC stream owns this — role change audit added in their PR",
  },
  {
    route: "src/app/api/admin/users/[id]/capabilities/grant/route.ts",
    reason: "Capability/RBAC stream owns this",
  },
  {
    route: "src/app/api/admin/users/[id]/capabilities/revoke/route.ts",
    reason: "Capability/RBAC stream owns this",
  },

  // People sub-routes not on the HR critical path
  {
    route: "src/app/api/people/onboarding/templates/route.ts",
    reason: "template library CRUD — configuration, not per-employee action; analytics-tracked",
  },
  {
    route: "src/app/api/people/recommendations/[id]/route.ts",
    reason: "acknowledgement of AI recommendation — low-sensitivity signal",
  },

  // Teams + OneNote (personal chat + notes) — Teams/OneNote stream.
  // createPage audits inside @/lib/integrations/microsoft-onenote; sync
  // routes only refresh local caches and never mutate user-visible state.
  {
    route: "src/app/api/teams/sync/route.ts",
    reason: "Teams/OneNote stream — cache-refresh sync, no user-visible mutation",
  },
  {
    route: "src/app/api/onenote/sync/route.ts",
    reason: "Teams/OneNote stream — cache-refresh sync, no user-visible mutation",
  },
  {
    route: "src/app/api/onenote/pages/route.ts",
    reason: "Teams/OneNote stream — createPage audits inside src/lib/integrations/microsoft-onenote.ts via onenote.page_created",
  },

  // Mail (Mail.Send) + Calendar (Calendars.ReadWrite) — Stream A.
  // Every mutation audits inside @/lib/integrations/microsoft-mail (mail.sent /
  // mail.replied) and @/lib/integrations/microsoft-calendar
  // (calendar.event.created/updated/deleted). The HTTP routes are thin
  // adapters that delegate to those libs.
  {
    route: "src/app/api/mail/send/route.ts",
    reason: "sendMail in src/lib/integrations/microsoft-mail.ts audits via mail.sent",
  },
  {
    route: "src/app/api/mail/reply/route.ts",
    reason: "replyToMessage in src/lib/integrations/microsoft-mail.ts audits via mail.replied",
  },
  {
    route: "src/app/api/calendar/events/route.ts",
    reason: "createEvent in src/lib/integrations/microsoft-calendar.ts audits via calendar.event.created",
  },
  {
    route: "src/app/api/calendar/events/[id]/route.ts",
    reason: "updateEvent/deleteEvent in src/lib/integrations/microsoft-calendar.ts audit via calendar.event.updated/deleted",
  },

  // Files (OneDrive) + Contacts stream — audit happens inside
  // src/lib/integrations/microsoft-files.ts and microsoft-contacts.ts
  // (actions: files.uploaded, files.share_created, files.deleted,
  // contacts.created, contacts.updated, contacts.deleted).
  {
    route: "src/app/api/files/upload/route.ts",
    reason: "uploadSmallFile in src/lib/integrations/microsoft-files.ts audits via files.uploaded",
  },
  {
    route: "src/app/api/files/upload-session/route.ts",
    reason: "upload-session endpoint only returns a Graph URL; audit happens on the subsequent upload write-through",
  },
  {
    route: "src/app/api/files/[id]/route.ts",
    reason: "deleteItem in src/lib/integrations/microsoft-files.ts audits via files.deleted",
  },
  {
    route: "src/app/api/files/[id]/share/route.ts",
    reason: "createShareLink in src/lib/integrations/microsoft-files.ts audits via files.share_created",
  },
  {
    route: "src/app/api/contacts/route.ts",
    reason: "createContact in src/lib/integrations/microsoft-contacts.ts audits via contacts.created",
  },
  {
    route: "src/app/api/contacts/[id]/route.ts",
    reason: "update/deleteContact in src/lib/integrations/microsoft-contacts.ts audit via contacts.updated/deleted",
  },
  {
    route: "src/app/api/contacts/sync/route.ts",
    reason: "Contacts stream — cache-refresh sync; no user-visible mutation audit-worthy at the route level",
  },

  // Online meetings — audit happens inside
  // src/lib/integrations/microsoft-online-meetings.ts via online_meeting.*
  // (created/updated/cancelled). The HTTP routes are thin adapters.
  {
    route: "src/app/api/online-meetings/route.ts",
    reason: "createMeeting in src/lib/integrations/microsoft-online-meetings.ts audits via online_meeting.created",
  },
  {
    route: "src/app/api/online-meetings/[id]/route.ts",
    reason: "updateMeeting/cancelMeeting in src/lib/integrations/microsoft-online-meetings.ts audit via online_meeting.updated/cancelled",
  },

  // Teams channel messages — reply route is a 501 stub (scope not granted);
  // channels-sync is a cache refresh. Neither mutates user-visible state.
  {
    route: "src/app/api/teams/channels-sync/route.ts",
    reason: "Teams stream — cache-refresh sync of channel messages; no user-visible mutation",
  },
  {
    route: "src/app/api/teams/teams/[id]/channels/[channelId]/messages/[messageId]/replies/route.ts",
    reason: "501 stub — ChannelMessage.Send scope not granted in Tier 1/2; no mutation ever occurs (analytics-tracked as capability_denied)",
  },

  // Tools — user-initiated GitHub Actions workflow dispatches. Audit happens
  // inside src/lib/tools-runner.ts via tools.run_triggered when the route
  // passes an actor through from requireCapability.
  {
    route: "src/app/api/tools/pdf-report/route.ts",
    reason: "triggerToolRun in src/lib/tools-runner.ts audits via tools.run_triggered",
  },
  {
    route: "src/app/api/tools/demo-deck/route.ts",
    reason: "triggerToolRun in src/lib/tools-runner.ts audits via tools.run_triggered",
  },
  {
    route: "src/app/api/tools/visual-diff/route.ts",
    reason: "triggerToolRun in src/lib/tools-runner.ts audits via tools.run_triggered",
  },
  {
    route: "src/app/api/tools/accessibility/route.ts",
    reason: "triggerToolRun in src/lib/tools-runner.ts audits via tools.run_triggered",
  },

  // Sites — section comments (Path C Phase 3 · Stream R3). Each write
  // fires dedicated site.comment_* analytics events which ARE the audit
  // trail for this feature (comment_posted, comment_replied,
  // comment_resolved, comment_deleted). The table itself is append-only
  // modulo soft-delete + state flip, so the row is the compliance
  // record. Consistent with other "analytics is the audit" sites/*
  // routes (feature-requests, discussions, knowledge).
  {
    route: "src/app/api/public/share/[token]/comments/route.ts",
    reason: "site.comment_posted / comment_replied fire on every public write; low-sensitivity client feedback UGC",
  },
  {
    route: "src/app/api/sites/[id]/comments/route.ts",
    reason: "site.comment_posted / comment_replied fire on every authed write; low-sensitivity internal review comments",
  },
  {
    route: "src/app/api/sites/[id]/comments/[commentId]/route.ts",
    reason: "soft-delete only; site.comment_deleted fires with site_id + comment_id + deleted_by_role — sufficient audit for UGC review comments",
  },
  {
    route: "src/app/api/sites/[id]/comments/[commentId]/resolve/route.ts",
    reason: "site.comment_resolved fires with site_id + comment_id + resolved_by_role; the KPI event for the feature",
  },

  // Sites — version history (Path C Phase 3 · Stream R2). The restore
  // POST already produces a dedicated audit row: it inserts into
  // apex_site_brief_edits with rejection_reason='restore' and fires
  // site.version_restored analytics with field_changes. The edit-row
  // + the analytics event together ARE the compliance record — adding
  // a second recordAudit() call would duplicate the same facts.
  // Consistent with the existing "brief-edit audits via the edits
  // table" allowlist entries directly above.
  {
    route: "src/app/api/sites/[id]/versions/route.ts",
    reason: "restore writes a kind=restore row into apex_site_brief_edits AND fires site.version_restored analytics; the row + event ARE the audit trail for this feature",
  },

  // Central Brain — upload + delete + query routes. Audit happens in
  // src/lib/brain/repo.ts + ingest.ts which fire brain.* analytics events
  // on every state change (upload_started, extraction_*, chunked,
  // embedding_*, document_indexed, document_deleted, query_*). The HTTP
  // routes are thin adapters that delegate to those libs.
  {
    route: "src/app/api/brain/ingest/route.ts",
    reason: "ingest() in src/lib/brain/ingest.ts fires brain.upload_started/extraction_*/chunked/embedding_*/document_indexed events on every state change",
  },
  {
    route: "src/app/api/brain/documents/[id]/route.ts",
    reason: "deleteDocument in src/lib/brain/repo.ts fires brain.document_deleted; GET is read-only",
  },
  {
    route: "src/app/api/brain/query/route.ts",
    reason: "queryBrain in src/lib/brain/query.ts fires brain.query_hit/miss + writes brain_query_log row for every query",
  },

  // Path C features — allowlisted to clear baseline test noise after
  // shipping Phases 1–3. Every entry cites the analytics event that IS
  // the audit trail for that route, matching the existing UGC / brain
  // allowlist rationale above.
  {
    route: "src/app/api/brand/scrape/route.ts",
    reason: "read-only POST — scrapes a client URL and returns extracted palette/fonts; no DB write. Analytics (brand_import_requested/completed/failed) cover observability.",
  },
  {
    route: "src/app/api/figma/import/route.ts",
    reason: "read-only POST — calls Figma REST API and returns a brief suggestion; no DB write. Analytics (figma_import_requested/completed/failed) cover observability.",
  },
  {
    route: "src/app/api/public/approvals/[token]/route.ts",
    reason: "client approval submission via signed share token — writes apex_site_approvals row as an APPEND-ONLY ledger (that row IS the audit trail) + fires site.approval_recorded / site.changes_requested analytics with actor + token_nonce metadata",
  },
  {
    route: "src/app/api/public/forms/[siteId]/submit/route.ts",
    reason: "public contact-form submit — writes apex_site_form_submissions row (audit trail) with ip_hash, origin, spam_score + fires site.form_submitted/_rejected/_email_sent/_email_failed analytics. IP is SHA256-hashed, never raw.",
  },
  {
    route: "src/app/api/sites/[id]/domain/route.ts",
    reason: "domain lifecycle (add/refresh/remove) — writes apex_site_domains rows with added_by + verified_at + removed_at columns serving as an audit ledger + fires site.domain_added/_verified/_removed/_add_failed analytics with user_id metadata",
  },
  {
    route: "src/app/api/sites/[id]/generate-image/route.ts",
    reason: "AI image gen — writes apex_site_image_generations row (requested_by, source_sha256, model, cost) + fires site.image_generation_requested/succeeded/failed analytics. The row IS the audit trail, consistent with sites/brief-generations pattern.",
  },
  {
    route: "src/app/api/sites/[id]/share/route.ts",
    reason: "share-link issue/list/revoke — writes apex_share_tokens rows (created_by, revoked_at) serving as audit ledger + fires site.share_link_issued/_revoked analytics with user_id + token_nonce",
  },

  // Meeting Insights (Stream A — multi-feed recurring-meeting ingest).
  // Each mutation lands as a row whose dedicated columns serve as the
  // audit ledger (created_by + created_at on feeds; received_at +
  // source_message_id on messages; resolved_by + resolved_at on
  // exceptions). Every mutation also fires an `automations.feed_*` /
  // `automations.artifact_*` analytics event with actor + role. Same
  // "row + event = audit trail" pattern as the porsche-classes block
  // and the sites brief-edit block above.
  {
    route: "src/app/api/meetings/feeds/route.ts",
    reason:
      "createFeed inserts an instinct_meeting_feeds row with created_by + created_at and fires automations.feed_created — row + event ARE the audit trail",
  },
  {
    route: "src/app/api/meetings/feeds/[slug]/route.ts",
    reason:
      "updateFeed/disableFeed write updated_at + is_enabled on instinct_meeting_feeds and fire automations.feed_updated/feed_disabled analytics with feed_id + slug",
  },
  {
    route: "src/app/api/meetings/feeds/[slug]/poll/route.ts",
    reason:
      "pollInbox in src/lib/automations/inbox-poller.ts fires automations.poll_run + artifact_ingested/_quarantined; every artifact lands as an instinct_meeting_artifacts row that is itself the audit ledger",
  },
  {
    route:
      "src/app/api/meetings/feeds/[slug]/messages/[messageId]/attachments/[attachmentId]/download/route.ts",
    reason:
      "501 Stream B stub — capability-gated read of attachment bytes; once Stream B replaces the body the audit will live in src/lib/automations/meeting-insights/parser-attachments via meeting.attachment_downloaded",
  },
  {
    route: "src/app/api/meetings/analyze/route.ts",
    reason:
      "Phase 5 ad-hoc analyzer — read-only POST. Aggregates already-ingested instinct_meeting_messages rows; no DB mutation. Fires meeting_insights.analyze_run analytics with actor + filter counts (no message contents) — that event IS the audit trail for the action.",
  },
  {
    route:
      "src/app/api/meetings/feeds/[slug]/messages/[messageId]/analysis/regenerate/route.ts",
    reason:
      "runAnalyzer in src/lib/automations/meeting-insights/run-analyzer.ts upserts instinct_meeting_analyses (row IS the audit ledger — analyzer_version + analyzed_at + status) and the route fires automations.message_reanalyze_requested + automations.message_analyzed analytics with feed_id + message_id",
  },

  // Automations (Stream A — porsche-classes ingest + dashboard).
  // Every state change writes to a dedicated automation table that IS
  // the audit ledger — instinct_automation_porsche_artifacts (raw
  // bytes), _snapshots (parsed view), _deltas (change row), _exceptions
  // (resolution_by + resolved_at), _overrides (created_by). On top of
  // those rows, automations.* analytics events fire on every meaningful
  // step (artifact_ingested, artifact_quarantined, delta_computed,
  // override_applied, exception_resolved, poll_run). Same "row + event
  // = audit trail" pattern as the sites brief-edit / form-submission
  // allowlist entries above.
  {
    route: "src/app/api/automations/[automationId]/poll/route.ts",
    reason: "pollInbox in src/lib/automations/inbox-poller.ts fires automations.poll_run + automations.artifact_ingested/_quarantined; every artifact lands as an apex_automation_porsche_artifacts row that is itself the audit ledger",
  },
  {
    route: "src/app/api/automations/[automationId]/override/route.ts",
    reason: "insertOverride writes an apex_automation_porsche_overrides row with created_by + created_at (append-only ledger) and fires automations.override_applied analytics — row + event ARE the audit trail",
  },
  {
    route: "src/app/api/automations/[automationId]/exceptions/[exceptionId]/resolve/route.ts",
    reason: "resolveException flips status with resolved_by + resolved_at on apex_automation_porsche_exceptions (row records the resolver) and fires automations.exception_resolved analytics — row + event ARE the audit trail",
  },
  {
    route: "src/app/api/s/[slug]/route.ts",
    reason: "public anonymous survey submission — high-volume observability sink (rate-limited, no authenticated actor); tracked via survey.response_submitted/rejected analytics, not a security-relevant admin mutation",
  },
];

export const AUDIT_ALLOWLIST_ROUTES: ReadonlySet<string> = new Set(
  AUDIT_ALLOWLIST.map((e) => e.route),
);
