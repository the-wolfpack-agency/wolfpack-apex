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
];

export const AUDIT_ALLOWLIST_ROUTES: ReadonlySet<string> = new Set(
  AUDIT_ALLOWLIST.map((e) => e.route),
);
