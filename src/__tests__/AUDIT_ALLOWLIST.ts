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
];

export const AUDIT_ALLOWLIST_ROUTES: ReadonlySet<string> = new Set(
  AUDIT_ALLOWLIST.map((e) => e.route),
);
