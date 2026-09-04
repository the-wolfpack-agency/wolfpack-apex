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
  // Delegated auditing
  {
    route: "src/app/api/gate/complete/route.ts",
    reason: "external-agent inference served through the model router; recordRouterCall writes the hash-chained AI ledger entry for every completion (counts, rule ids and cost, never content), which is where the model, provider and spend are actually known, so the route delegates rather than writing a second, thinner record",
  },
  {
    route: "src/app/api/assistant/broadcast/route.ts",
    reason: "broadcastToAssistants() in src/lib/assistant/broadcast.ts records the hash-chained audit entry itself, naming the sender, the recipient count and how many were actually delivered, so the route delegates rather than double-auditing; the lib is the right place for it because the delivered and failed counts are only known after the fan-out",
  },
  {
    route: "src/app/api/admin/platform-scans/browser/authorize/route.ts",
    reason: "authorization-query endpoint; the gate (authorizeBrowserAction) writes the hash-chained audit for every allow/deny decision, so the route delegates rather than double-auditing",
  },
  {
    route: "src/app/api/gate/authorize/route.ts",
    reason: "bring-your-own-agent gate-as-a-service authorization query; authorize() in src/lib/ogiam/authorize.ts records every external decision to the tamper-evident hash-chained ledger (and fails closed on an unauditable decision in enforce mode), so the route delegates rather than double-auditing",
  },
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
    route: "src/app/api/admin/ogiam/simulate/route.ts",
    reason: "read-only enforcement simulator; POST only to carry the candidate enforce-set in the body. Replays the ogiam_decisions ledger and returns a report, no state change, fires ogiam.policy_simulated analytics",
  },
  {
    route: "src/app/api/admin/ai-surfaces/scan/route.ts",
    reason: "shadow-AI discovery; records a read-derived inventory of AI touchpoints found in supplied source (no domain-state mutation) and fires ai_inventory.scan_completed, mirroring the agent-baseline read-derived-snapshot precedent",
  },
  {
    route: "src/app/api/admin/ai-surfaces/repo-scan/route.ts",
    reason: "live public-repo shadow-AI discovery; fetches a github.com repo's source (read-only, SSRF-guarded, capped) and records the SAME read-derived inventory of AI touchpoints the ai-surfaces/scan route writes (no domain-state mutation), firing ai_inventory.repo_scan_completed / ai_inventory.remediation_suggested — same read-derived-snapshot posture as the supplied-source scan",
  },
  {
    route: "src/app/api/admin/ai-surfaces/mcp-scan/route.ts",
    reason: "static MCP risk scan; records a read-derived inventory of configured MCP servers from a supplied config/manifest (no MCP connection, no domain-state mutation) and fires mcp.scan_completed / mcp.finding_detected, same read-derived-snapshot posture as the AI-surface scan",
  },
  {
    route: "src/app/api/admin/ai-redteam/run/route.ts",
    reason: "continuous AI red-team; runs an adversarial corpus through the real gate (deterministic, offline, no domain mutation) and records a read-derived assurance run, firing ai_redteam.run_completed / ai_redteam.vuln_detected, same read-derived-snapshot posture as the gate self-test",
  },
  {
    route: "src/app/api/admin/compliance/report/route.ts",
    reason: "compliance engine; derives a framework report from measured OGIAM evidence (audit chain, gate decisions, red-team, AI inventory) and records a read-derived report (no domain mutation), firing compliance.report_generated / compliance.gap_detected, same read-derived-snapshot posture as the AI-surface scan",
  },
  {
    route: "src/app/api/admin/ogiam/governance-alerts/scan/route.ts",
    reason: "governance drift alert sweep; detects regressions from existing governance signals (red-team pass-rate history, ungoverned-AI-surface inventory) and dispatches a notification through the notifications layer (which writes its own per-recipient DB rows). The only row it writes is the (workspace_id, alert_kind, fingerprint) dedupe claim so it never re-alerts — no domain-state mutation. Fires ogiam.drift_alert_dispatched per dispatched alert; same read-derived-snapshot posture as the ai-redteam run and ai-surfaces scan",
  },
  {
    route: "src/app/api/admin/compliance/report/export/route.ts",
    reason: "signed evidence export; serializes + signs an EXISTING stored compliance report (canonical JSON + detached signature + printable HTML) fetched workspace-scoped via getReportById — read-derived, no domain mutation — and fires compliance.evidence_exported, mirroring the compliance/report read-derived-snapshot entry above",
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

  // RBAC mutation routes (role change, capability grant/revoke) are NOT
  // allowlisted: they call recordAudit directly. Role/capability changes are
  // exactly the security-relevant authority changes the hash-chained audit log
  // exists for. See src/app/api/admin/users/[id]/role/route.ts and the
  // capabilities/grant + revoke routes.

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
    route: "src/app/api/mail/draft/route.ts",
    reason: "createDraft in src/lib/integrations/microsoft-mail.ts audits via mail.drafted",
  },
  {
    route: "src/app/api/web-search/route.ts",
    reason: "read-only external web-search proxy; returns results, mutates no persistent state",
  },
  {
    route: "src/app/api/site-analytics/ingest/route.ts",
    reason: "anonymous marketing-site telemetry (no PII, no user, no security-relevant state)",
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
  {
    route: "src/app/api/s/[slug]/view/route.ts",
    reason: "public survey view counter: high-volume observability ping, no authenticated actor; tracked via survey.viewed analytics, not security-relevant",
  },

  // Admin diagnostics + product feedback (capability-gated reads / product
  // data). None grant roles, mint credentials, export bulk data, or
  // impersonate: convention reserves the hash chain for those. Probes are
  // read-only health checks; feedback is product UGC covered by analytics.
  {
    route: "src/app/api/admin/azure-probe/route.ts",
    reason: "read-only health probe: fires one synthetic OCR call to prove Azure auth; no state change, admin.health.probe-gated; observability only",
  },
  {
    route: "src/app/api/admin/connectors/[name]/verify/route.ts",
    reason: "read-only connector health check: issues one low-cost vendor read to prove tokens work; settings.manage_team-gated; no security-relevant mutation",
  },
  {
    route: "src/app/api/admin/feedback/[id]/route.ts",
    reason: "feedback resolve/reopen: product data, settings.manage_team-gated + RLS; assistant.feedback_resolved analytics is the trail; not a security-audit event (owned by feedback stream)",
  },
  {
    route: "src/app/api/feedback/route.ts",
    reason: "free-form user feedback capture: product UGC, assistant.use-gated + RLS; assistant.feedback_recorded analytics is the trail; not a security-audit event (owned by feedback stream)",
  },

  // Assistant surface: chat-adjacent drafting + form submit. No durable
  // security-relevant state change; analytics already tracks the action.
  {
    route: "src/app/api/assistant/draft-reply/route.ts",
    reason: "produces a draft reply (LLM text): no persistent state change; assistant analytics covers observability",
  },
  {
    route: "src/app/api/assistant/forms/submit/route.ts",
    reason: "assistant form submission: routes to the underlying tool which audits its own mutation; analytics tracks the submit",
  },

  // Automations (porsche-classes ingest, quarantine, audit-revert, config).
  // Every state change lands in a dedicated automation table that IS the
  // audit ledger (created_by/created_at, resolved_by/resolved_at) and fires
  // automations.* analytics. Same "row + event = audit trail" pattern as the
  // existing automations allowlist block above.
  {
    route: "src/app/api/automations/[automationId]/audit/[id]/revert/route.ts",
    reason: "revert writes an append-only correction row to the automation table with reverted_by + reverted_at and fires automations.delta_reverted: row + event ARE the audit trail",
  },
  {
    route: "src/app/api/automations/[automationId]/quarantine/[id]/reprocess/route.ts",
    reason: "reprocess of a quarantined artifact: re-runs the ingest pipeline (artifact_ingested/_quarantined analytics + artifact row); no separate security-relevant mutation",
  },
  {
    route: "src/app/api/automations/[automationId]/summaries/[classKey]/upload-sharepoint/route.ts",
    reason: "uploads a generated summary to SharePoint via the connector lib; fires automations.summary_uploaded analytics; document push, not a security-audit event",
  },
  {
    route: "src/app/api/automations/porsche-classes/config/route.ts",
    reason: "automation config CRUD: operational settings, not security-relevant; updated_at column + automations.config_updated analytics form the trail",
  },
  {
    route: "src/app/api/automations/porsche-classes/config/sharepoint-test/route.ts",
    reason: "read-only SharePoint connectivity test: proves the config can reach the source; no state change",
  },
  {
    route: "src/app/api/automations/porsche-classes/manual-ingest/route.ts",
    reason: "manual trigger of the ingest pipeline: every artifact lands as an automation row (the audit ledger) and fires automations.artifact_ingested/_quarantined",
  },

  // Central Brain upload (filtered widget path). Audit happens in
  // src/lib/brain/ingest.ts which fires brain.* analytics on every state
  // change: same rationale as the brain/ingest allowlist entry above.
  {
    route: "src/app/api/brain/upload/route.ts",
    reason: "ingest() in src/lib/brain/ingest.ts fires brain.upload_started/extraction_*/chunked/embedding_*/document_indexed on every state change; the filtered upload twin of brain/ingest",
  },

  // Bulletin boards + notes: internal collaboration UGC. Capability-gated
  // + RLS; bulletin.* analytics track every write. Same low-sensitivity-UGC
  // rationale as journal/knowledge/discussions above.
  {
    route: "src/app/api/bulletin/boards/route.ts",
    reason: "bulletin board CRUD: internal collaboration UGC, capability-gated + RLS, bulletin.board_* analytics; not security-relevant",
  },
  {
    route: "src/app/api/bulletin/boards/[id]/route.ts",
    reason: "bulletin board edit/delete: internal UGC, analytics-tracked + RLS",
  },
  {
    route: "src/app/api/bulletin/boards/[id]/notes/route.ts",
    reason: "bulletin note create: internal collaboration UGC, bulletin.note_created analytics",
  },
  {
    route: "src/app/api/bulletin/boards/[id]/snapshot/route.ts",
    reason: "board snapshot generation: produces a point-in-time view; no security-relevant mutation",
  },
  {
    route: "src/app/api/bulletin/notes/[id]/route.ts",
    reason: "bulletin note edit/delete: internal UGC, analytics-tracked + RLS",
  },

  // SharePoint connector sources: configuration + cache-sync CRUD. Source
  // rows carry created_by/updated_at; connectors.source_* analytics track
  // writes. Configuration data, not a security-audit event.
  {
    route: "src/app/api/connectors/sharepoint/sources/route.ts",
    reason: "SharePoint source registration CRUD: connector configuration, capability-gated; connectors.source_added analytics + source row are the trail",
  },
  {
    route: "src/app/api/connectors/sharepoint/sources/[id]/route.ts",
    reason: "SharePoint source edit/delete: connector configuration, analytics-tracked",
  },
  {
    route: "src/app/api/connectors/sharepoint/sources/[id]/sync/route.ts",
    reason: "SharePoint cache-refresh sync: no user-visible state mutation; connectors.source_synced analytics",
  },
  {
    route: "src/app/api/connectors/sharepoint/sync-all/route.ts",
    reason: "SharePoint estate cache-refresh: walks every active source and runs the same allowlisted per-source sync; connectors.sharepoint.estate_sync_finished + per-source sync_finished analytics are the trail. Same class as the per-source sync above, capability-gated (settings.manage_team)",
  },
  {
    route: "src/app/api/connectors/sharepoint/sources/[id]/clear-stuck/route.ts",
    reason: "operational reset of a stuck sync flag: recovery action, not security-relevant; analytics-tracked",
  },

  // Document recognition (Azure OCR extraction). Produces extracted-field
  // rows; documents.recognized analytics track each run. Document-processing
  // CRUD, not a security-audit event.
  {
    route: "src/app/api/documents/recognize/route.ts",
    reason: "OCR extraction upload: capability-gated document processing; the extracted-fields row + documents.recognized analytics are the trail; PII pre-scanned before Azure",
  },
  {
    route: "src/app/api/documents/recognize/[id]/route.ts",
    reason: "recognized-document edit/delete: document-processing CRUD, analytics-tracked + RLS",
  },

  // Email signature detection: reads the user's Outlook signature to
  // pre-fill the signature editor. Per-user preference, no security concern.
  {
    route: "src/app/api/email-signatures/detect-from-outlook/route.ts",
    reason: "reads Outlook signature to pre-fill the editor: per-user preference; microsoft.signature_detected analytics; same rationale as email-signatures CRUD above",
  },

  // Inbox message surface (newer messages path). PATCH/DELETE + reply
  // delegate to src/lib/integrations/microsoft-mail.ts which audits via
  // mail.archived / mail.deleted / mail.replied: same rationale as the
  // emails/[id] allowlist entries above.
  {
    route: "src/app/api/emails/messages/[id]/route.ts",
    reason: "archive/delete delegate to microsoft-mail.ts which audits via mail.archived / mail.deleted",
  },
  {
    route: "src/app/api/emails/messages/[id]/reply/route.ts",
    reason: "reply/replyAll/forward delegate to microsoft-mail.ts which audits via mail.replied",
  },

  // Finance invoices: invoice document upload + scan + status CRUD.
  // Capability-gated (finance.invoices.manage) + RLS; the invoice row and
  // finance.invoice_* analytics are the trail. Business financial data, not
  // an auth/grant/export security event.
  {
    route: "src/app/api/finance/invoices/route.ts",
    reason: "invoice upload + scan: finance.invoices.manage-gated business data; invoice row + finance.invoice_uploaded analytics are the trail; deduped by SHA-256",
  },
  {
    route: "src/app/api/finance/invoices/[id]/route.ts",
    reason: "invoice status edit/delete: finance business data, capability-gated + RLS, analytics-tracked",
  },

  // Goals / OKRs: north star, objectives, key results, contributions.
  // Business planning data. Capability-gated + RLS; goals.* analytics track
  // every write. Not security-relevant; same rationale as clients/features.
  {
    route: "src/app/api/goals/north-star/route.ts",
    reason: "north-star metric CRUD: business planning data, capability-gated + RLS, goals.north_star_* analytics",
  },
  {
    route: "src/app/api/goals/north-star/[id]/route.ts",
    reason: "north-star edit/delete: business planning data, analytics-tracked",
  },
  {
    route: "src/app/api/goals/okrs/route.ts",
    reason: "OKR objective CRUD: business planning data, capability-gated + RLS, goals.okr_* analytics",
  },
  {
    route: "src/app/api/goals/okrs/[id]/route.ts",
    reason: "OKR edit/delete: business planning data, analytics-tracked",
  },
  {
    route: "src/app/api/goals/okrs/[id]/krs/route.ts",
    reason: "key-result create under an OKR: business planning data, goals.kr_created analytics",
  },
  {
    route: "src/app/api/goals/krs/[id]/route.ts",
    reason: "key-result edit/delete: business planning data, analytics-tracked",
  },
  {
    route: "src/app/api/goals/contributions/route.ts",
    reason: "goal-contribution create: business planning data, goals.contribution_* analytics",
  },
  {
    route: "src/app/api/goals/contributions/[id]/route.ts",
    reason: "contribution edit/delete: business planning data, analytics-tracked",
  },
  {
    route: "src/app/api/goals/contributions/[id]/grade/route.ts",
    reason: "grade a contribution: business planning signal, goals.contribution_graded analytics",
  },

  // Health check: read-only integration status aggregation.
  {
    route: "src/app/api/health/integrations/route.ts",
    reason: "read-only integration health aggregation: proves external connections; no state change",
  },

  // HR scanned documents: document upload/extraction with PII pre-scan.
  // Capability-gated (hr.documents.upload) + RLS; PII is redacted before
  // Azure and never stored raw. Document-processing CRUD covered by
  // hr.document_* analytics; not an auth/grant/export security event.
  {
    route: "src/app/api/hr/scanned-documents/route.ts",
    reason: "HR document upload + extract: hr.documents.upload-gated; PII pre-scanned + redacted before Azure; hr.document_scanned analytics + row are the trail; document CRUD not security-audit",
  },
  {
    route: "src/app/api/hr/scanned-documents/[id]/route.ts",
    reason: "HR scanned-document edit/delete: document CRUD, hr.documents-gated + RLS, analytics-tracked",
  },

  // Job codes: finance cost-coding config + receipt scan-and-apply.
  // Configuration + business data; job_codes.* analytics track writes.
  {
    route: "src/app/api/job-codes/[code]/cell/route.ts",
    reason: "job-code cell edit: cost-coding configuration data, analytics-tracked",
  },
  {
    route: "src/app/api/job-codes/refresh/route.ts",
    reason: "refresh job-code list from source: cache refresh, no security-relevant mutation",
  },
  {
    route: "src/app/api/job-codes/scan-receipt/route.ts",
    reason: "receipt scan upload: OCR extraction producing a draft coding row; job_codes.receipt_scanned analytics; business data",
  },
  {
    route: "src/app/api/job-codes/scan-receipt/[id]/apply/route.ts",
    reason: "apply a scanned receipt's coding: business cost-coding write, job_codes.receipt_applied analytics",
  },

  // Invoice tracker: read-only SharePoint mirror. The only "mutation" route
  // refreshes the local cache from the external workbook — it writes no business
  // entity, and every refresh + access is on the learning spine via
  // invoice_tracker.* analytics events.
  {
    route: "src/app/api/invoices/[company]/refresh/route.ts",
    reason: "force a live re-pull of the read-only invoice mirror: cache refresh only, no security-relevant mutation; invoice_tracker.refreshed/refresh_failed analytics",
  },

  // Knowledge base: entry edit/delete, ask (read-only retrieval), feedback.
  // Low-sensitivity UGC + retrieval; same rationale as the knowledge/* and
  // rate allowlist entries above.
  {
    route: "src/app/api/knowledge/[id]/route.ts",
    reason: "knowledge entry edit/delete: public-within-team UGC, analytics-tracked + RLS",
  },
  {
    route: "src/app/api/knowledge/ask/route.ts",
    reason: "knowledge retrieval (RAG query): read-only; produces an answer, no mutation; knowledge.question_asked analytics",
  },
  {
    route: "src/app/api/knowledge/feedback/route.ts",
    reason: "thumbs feedback on a knowledge answer: low-sensitivity signal, knowledge.feedback_recorded analytics",
  },

  // Per-user UI preferences + lightweight state. Personal, non-sensitive;
  // analytics covers observability. No compliance concern.
  {
    route: "src/app/api/me/welcome-tooltip/route.ts",
    reason: "per-user dismiss of an onboarding tooltip: UI preference, no security/compliance concern",
  },
  {
    route: "src/app/api/messages/read-state/route.ts",
    reason: "per-user message read-state toggle: UI state, scoped by JWT user.id; not security-relevant",
  },
  {
    route: "src/app/api/user-nav-prefs/route.ts",
    reason: "per-user navigation preferences: UI personalization, scoped by user.id; not security-relevant",
  },

  // Microsoft Graph sync + presence + Teams message send. Cache refreshes
  // mutate no user-visible state; the Teams send delegates to the Graph
  // integration lib which audits its own mutation.
  {
    route: "src/app/api/ms-graph/sync/route.ts",
    reason: "Graph cache-refresh sync: refreshes local caches, no user-visible mutation; system.ms_graph_synced analytics",
  },
  {
    route: "src/app/api/ms/presence/route.ts",
    reason: "presence set/refresh: ephemeral Graph presence state, no durable security-relevant mutation",
  },
  {
    route: "src/app/api/ms/teams/[teamId]/channels/[channelId]/messages/route.ts",
    reason: "Teams channel message send: delegates to the Graph integration lib; teams.message_sent analytics; chat content, not a security-audit event",
  },

  // Salesforce portal record write: connector-mediated CRM upsert. The
  // connector lib tracks portal.record_* analytics; CRM business data.
  {
    route: "src/app/api/portal/salesforce/record/route.ts",
    reason: "Salesforce record upsert via connector: CRM business data, capability-gated; portal.record_upserted analytics is the trail; not security-relevant",
  },

  // Principles engine: definition CRUD + evaluation runs + sync. Operational
  // config + read-only evaluations; principles.* analytics track writes.
  {
    route: "src/app/api/principles/route.ts",
    reason: "principle definition CRUD: operational configuration, principles.principle_* analytics + RLS",
  },
  {
    route: "src/app/api/principles/[id]/route.ts",
    reason: "principle edit/delete: operational configuration, analytics-tracked",
  },
  {
    route: "src/app/api/principles/[id]/evaluate/route.ts",
    reason: "evaluate one principle: read-only scoring run; principles.evaluated analytics, no security-relevant mutation",
  },
  {
    route: "src/app/api/principles/[id]/retire/route.ts",
    reason: "retire a principle: soft state flip on config row, principles.retired analytics",
  },
  {
    route: "src/app/api/principles/config/route.ts",
    reason: "principles-engine config: operational settings, analytics-tracked",
  },
  {
    route: "src/app/api/principles/evaluate-all/route.ts",
    reason: "batch evaluate all principles: read-only scoring run; principles.evaluated analytics, no mutation",
  },
  {
    route: "src/app/api/principles/sync-now/route.ts",
    reason: "principles source sync: cache refresh, no user-visible mutation",
  },

  // Programs budgets: budget headers, lines, actuals, xlsx import.
  // Business financial planning data. Capability-gated + RLS; programs.budget_*
  // analytics track writes. Not an auth/grant/export security event.
  {
    route: "src/app/api/programs/budgets/route.ts",
    reason: "budget header CRUD: business financial planning data, capability-gated + RLS, programs.budget_* analytics",
  },
  {
    route: "src/app/api/programs/budgets/[id]/route.ts",
    reason: "budget edit/delete: business financial data, analytics-tracked",
  },
  {
    route: "src/app/api/programs/budgets/[id]/lines/route.ts",
    reason: "budget line create: business financial data, programs.budget_line_* analytics",
  },
  {
    route: "src/app/api/programs/budgets/[id]/lines/[lineId]/route.ts",
    reason: "budget line edit/delete: business financial data, analytics-tracked",
  },
  {
    route: "src/app/api/programs/budgets/[id]/actuals/route.ts",
    reason: "post budget actuals: business financial data, programs.budget_actuals_posted analytics",
  },
  {
    route: "src/app/api/programs/budgets/import-xlsx/route.ts",
    reason: "xlsx budget import: bulk business-data load into budget rows, programs.budget_imported analytics; financial planning data, not a security export",
  },

  // QR code generator: read-only POST producing an image; no state change.
  {
    route: "src/app/api/qr/route.ts",
    reason: "QR image generator: read-only POST, renders an image from input; no DB write",
  },
  {
    route: "src/app/api/qr/[id]/export/route.ts",
    reason: "export beacon: read-only POST, fires assistant.qr_code_exported analytics on download; no DB write/state change",
  },

  // Support tickets: ticket CRUD, AI draft, send, feedback, diagnostics,
  // pattern config. Support-desk product data + LLM drafting. Capability-gated
  // + RLS; support.* analytics track writes. Sends delegate to the mail lib
  // which audits via mail.sent. Not an auth/grant/export security event.
  {
    route: "src/app/api/support/tickets/route.ts",
    reason: "support ticket create/list: support-desk product data, capability-gated + RLS, support.ticket_created analytics",
  },
  {
    route: "src/app/api/support/tickets/[id]/route.ts",
    reason: "ticket edit/status update: support product data, analytics-tracked",
  },
  {
    route: "src/app/api/support/tickets/[id]/draft/route.ts",
    reason: "AI draft reply for a ticket: produces LLM text, no send; support.reply_drafted analytics",
  },
  {
    route: "src/app/api/support/tickets/[id]/send/route.ts",
    reason: "send a ticket reply: delegates to the mail lib which audits via mail.sent; support.reply_sent analytics",
  },
  {
    route: "src/app/api/support/tickets/[id]/feedback/route.ts",
    reason: "feedback on a ticket reply: low-sensitivity quality signal, support.reply_feedback analytics",
  },
  {
    route: "src/app/api/support/tickets/[id]/auto-ack-diag/route.ts",
    reason: "read-only diagnostic of the auto-ack rules for a ticket: returns evaluation, no state change",
  },
  {
    route: "src/app/api/support/patterns/[id]/route.ts",
    reason: "support auto-reply pattern edit/delete: operational config, support.pattern_* analytics",
  },

  // Time entries: timesheet CRUD. Business operational data scoped by
  // user.id + RLS; time.entry_* analytics track writes.
  {
    route: "src/app/api/time-entries/route.ts",
    reason: "timesheet entry CRUD: business operational data scoped by user.id + RLS, time.entry_* analytics; not security-relevant",
  },

  // OGIAM agent runtime. Agent actions are governed and recorded elsewhere.
  {
    route: "src/app/api/agents/scan/route.ts",
    reason: "agent self-onboarding scan: read-only introspection of the tool registry; persists a derived system model, no security-relevant state change; agent.scan_completed analytics",
  },
  {
    route: "src/app/api/agents/act/route.ts",
    reason: "agent governed action: every dispatched step is deterministically authorized and recorded per-decision in the hash-chained OGIAM decision ledger attributed to the agent principal, which IS the agent-action audit trail; agent.acted analytics",
  },
  {
    route: "src/app/api/agents/run-tasks/route.ts",
    reason: "agent runtime: every dispatched step is authorized and recorded per-decision in the hash-chained OGIAM ledger attributed to the agent, and task completion fires agent.task_completed; the endpoint orchestrates, it does not itself mutate domain state",
  },

  // OGIAM agent drift detection. The baseline capture is a read-derived
  // snapshot; the hourly sweep auto-pauses via the lib (recorded in the drift
  // events table + agent.auto_paused analytics). The interactive drift-check
  // route calls recordAudit on pause so it needs no allowlist; the drift GET
  // is read-only.
  {
    route: "src/app/api/admin/agents/[id]/baseline/route.ts",
    reason: "captures a behavior baseline derived from the OGIAM decision ledger; read-derived snapshot, fires agent.baseline_captured; no domain-state mutation",
  },
  {
    route: "src/app/api/cron/agent-drift/route.ts",
    reason: "scheduled drift sweep; any auto-pause is recorded in instinct_agent_drift_events and agent.auto_paused analytics, and the drift-check route audits an interactive pause",
  },
  {
    route: "src/app/api/admin/prompt-review/route.ts",
    reason: "pure function over the request body; nothing is written and the brief is deliberately never stored. It is a POST only because a brief belongs in a body rather than a query string, which lands in access logs and referrer headers. An audit entry here would either record nothing useful or record the brief itself, which is the one thing the surface promises not to keep",
  },
];

export const AUDIT_ALLOWLIST_ROUTES: ReadonlySet<string> = new Set(
  AUDIT_ALLOWLIST.map((e) => e.route),
);
