/**
 * Capability registry — single source of truth for every permission in Instinct.
 *
 * Naming convention: `module.action` (dotted, lowercase). Keep it grep-friendly.
 * If you add a module, register every action here — the capability-coverage
 * guardrail test (`src/__tests__/capability-coverage.test.ts`) enforces that
 * every protected API route calls `requireCapability(...)` with one of these.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Audit provenance (2026-04-15):
 *   Capabilities derived from `src/app/(dashboard)/*` pages and
 *   `src/app/api/**` routes actually present in the codebase today.
 *   Forward-looking capabilities (payroll, tasks.*) are registered now so
 *   that the stream building those modules can plug in without touching
 *   this file's contract.
 *
 * Intentionally NOT registered here:
 *   - `assistant.role_*` conditional chat widget states → UI-only, not a
 *     permission boundary.
 *   - CSP/health/webhook endpoints (csp-report, plaud/webhook,
 *     sites/webhook, auth/login, auth/refresh, workspace/status,
 *     team/accept) → either public or caller-authenticated by signature.
 *     They live in CAPABILITY_ALLOWLIST instead.
 *   - `system.login` etc. analytics events → those are audit signals, not
 *     gated actions.
 * ──────────────────────────────────────────────────────────────────────────
 */

export const CAPABILITIES = {
  // HR
  "hr.employees.view": "View the HR employees list",
  "hr.employees.edit": "Edit an employee record",
  "hr.documents.view": "View HR documents",
  "hr.documents.upload": "Upload HR documents",
  "hr.benefits.view": "View benefits documents",
  "hr.payroll.view": "View payroll data",
  "hr.payroll.process": "Process payroll runs",
  "hr.onboarding.manage": "Manage onboarding templates and instances",
  "hr.insights.view": "View HR insights and recommendations",

  // Finance (QuickBooks)
  "finance.reports.view": "View financial reports (QuickBooks)",
  "finance.connect": "Connect/disconnect QuickBooks",

  // Clients
  "clients.view": "View clients list",
  "clients.edit": "Edit client records",

  // Meetings (Plaud transcripts)
  "meetings.view": "View meeting transcripts",
  "meetings.connect_plaud": "Connect org Plaud integration",

  // Docs
  "docs.view": "View docs",
  "docs.edit": "Edit docs",
  "docs.generate": "Generate new docs (AI-assisted)",

  // Reports
  "reports.view": "View reports",
  "reports.generate": "Generate new reports",

  // Journal
  "journal.write": "Write journal entries",
  "journal.read_all": "Read all team members' journals",

  // Discussions
  "discussions.post": "Post in discussions",
  "discussions.pin": "Pin/unpin threads",
  "discussions.resolve": "Mark discussions resolved",

  // Features board
  "features.view": "View the features page",
  "features.vote": "Vote on feature requests",
  "features.approve": "Approve or reject feature requests",

  // Knowledge & Assistant
  "knowledge.search": "Search knowledge base",
  "knowledge.rate": "Rate answers to train the learning loop",
  "assistant.use": "Use the Wolfpack Assistant",

  // Central Brain — team-wide knowledge ingestion + RAG
  "brain.read": "Query the central brain (RAG over ingested docs)",
  "brain.ingest": "Upload files into the central brain",
  "brain.manage": "Delete or re-ingest brain documents; view ingest health",

  // Sites
  "sites.view": "View sites dashboard",
  "sites.deploy": "Trigger site deploys",
  "sites.edit": "Edit site briefs and assets",

  // Settings
  "settings.view_own": "View own profile settings",
  "settings.view_workspace": "View workspace-wide settings",
  "settings.manage_integrations": "Manage workspace integrations",
  "settings.manage_team": "Invite / manage team members",

  // Admin
  "admin.audit_log.view": "View the audit log",
  "admin.roles.assign": "Change other users' roles and capability overrides",

  // Tasks (forward-looking — tasks stream owns implementation)
  "tasks.view": "View own tasks",
  "tasks.view_team": "View team tasks",
  "tasks.edit": "Edit own tasks",

  // Briefing / dashboard
  "briefing.view": "View the morning briefing",
  "dashboard.view": "View the main dashboard",

  // Emails
  "emails.view": "View email templates",
  "emails.send": "Send emails via workspace integrations",

  // Analytics
  "analytics.view": "View analytics dashboards",

  // Tools
  "tools.view": "View the tools dashboard",
  "tools.run": "Run tool actions (PDF, screenshots, diff)",

  // Automations — modular per-team-member workflow surface (capabilities
  // are AUTOMATION-WIDE so a single grant lights up every registered
  // automation, including the per-class summaries).
  "automations.view": "View the automations dashboard, per-class summaries, and per-automation pages",
  "automations.run": "Trigger ingest / poll for an automation",
  "automations.override": "Apply manual corrections (alias, exclude, class match) to an automation",
  "automations.resolve_exceptions": "Resolve or dismiss automation exceptions",
} as const;

export type Capability = keyof typeof CAPABILITIES;

/**
 * True if the given string is a registered capability. Narrows the type so
 * runtime validation (admin API input) and compile-time checks (registry
 * callers) use the same source.
 */
export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CAPABILITIES, value);
}

/**
 * Stable sorted list — useful for `/api/me/capabilities` responses and
 * snapshot tests.
 */
export function allCapabilities(): readonly Capability[] {
  return Object.keys(CAPABILITIES).sort() as Capability[];
}
