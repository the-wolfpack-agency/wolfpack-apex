/**
 * Role → default capabilities mapping.
 *
 * This is the hardcoded base set per role. Per-user overrides (grants /
 * revokes) are layered on top in `resolveCapabilities()`. See
 * `capabilities-resolve.ts` for the effective-set algorithm.
 *
 * Design notes:
 *   - `cto` is full admin (every capability).
 *   - `ceo` gets everything EXCEPT developer-only actions (site deploy,
 *     discussion pinning is left to devs/leadership) and admin role
 *     assignment is CEO-allowed too — CEO must be able to promote a CTO.
 *   - Non-privileged roles default CLOSED for finance + HR sensitive data.
 *   - `hr` is the only non-cto/ceo role that sees payroll/benefits/employees
 *     by default — their whole job.
 *   - `sales` + `ops` + `dev` + `designer` share a baseline of
 *     journal/docs/knowledge/assistant/tasks, and diverge from there.
 *
 * Anything sensitive that a role DOES get below is called out with a
 * trailing comment explaining why — so anyone adding a capability can see
 * the blast radius.
 */

import type { Capability } from "./capabilities";
import { CAPABILITIES } from "./capabilities";

export type TeamRole = "ceo" | "cto" | "dev" | "sales" | "ops" | "hr" | "designer";

const ALL_CAPS: readonly Capability[] = Object.keys(CAPABILITIES) as Capability[];

// ──────────────────────────────────────────────────────────────────────────
// Role baselines
// ──────────────────────────────────────────────────────────────────────────

/** CTO: full admin. Gets every registered capability. */
const CTO: readonly Capability[] = ALL_CAPS;

/** CEO: same as CTO minus dev-only deployment actions. Keeps admin + finance. */
const CEO: readonly Capability[] = ALL_CAPS.filter(
  (c) => c !== "sites.deploy",
);

/** HR: owns people + benefits + payroll. Sees meetings + docs + journal. */
const HR: readonly Capability[] = [
  // HR suite — full
  "hr.employees.view",
  "hr.employees.edit",
  "hr.documents.view",
  "hr.documents.upload",
  "hr.benefits.view",
  "hr.payroll.view",         // sensitive: HR reads payroll
  "hr.payroll.process",      // sensitive: HR runs payroll
  "hr.onboarding.manage",
  "hr.insights.view",
  // Cross-team reads
  "meetings.view",           // HR reads meeting-insights feeds (read-only — no manage / export)
  "clients.view",            // HR sometimes references clients in onboarding
  "docs.view",
  "docs.edit",
  "docs.generate",
  "reports.view",
  // Collaboration & knowledge
  "journal.write",
  "discussions.post",
  "discussions.resolve",
  "knowledge.search",
  "knowledge.rate",
  "assistant.use",
  // Central Brain — everyone in the org can read + contribute
  "brain.read",
  "brain.ingest",
  "features.view",
  "features.vote",
  // Self-service
  "settings.view_own",
  "briefing.view",
  "dashboard.view",
  "emails.view",
  // Tasks
  "tasks.view",
  "tasks.edit",
  // Tools (read-only)
  "tools.view",
  // Automations — Alicia is Program Director (HR-adjacent role); she's
  // the primary user of porsche-classes. Granting all four caps so the
  // dashboard, ingest trigger, override form, and exception queue all
  // light up for her without admin involvement.
  "automations.view",
  "automations.run",
  "automations.override",
  "automations.resolve_exceptions",
];

/** Sales: clients + meetings, read-only on docs/reports, no HR/finance. */
const SALES: readonly Capability[] = [
  "clients.view",
  "clients.edit",
  "meetings.view",
  "docs.view",
  "docs.generate",
  "reports.view",
  "journal.write",
  "discussions.post",
  "knowledge.search",
  "knowledge.rate",
  "assistant.use",
  // Central Brain — everyone in the org can read + contribute
  "brain.read",
  "brain.ingest",
  "features.view",
  "features.vote",
  "settings.view_own",
  "briefing.view",
  "dashboard.view",
  "emails.view",
  "emails.send",            // sales writes + sends client emails
  "tasks.view",
  "tasks.edit",
  "tools.view",
  "automations.view",        // sales sees the automations dashboard read-only
];

/** Ops: internal process + docs. No HR, no finance, no deploys. */
const OPS: readonly Capability[] = [
  "docs.view",
  "docs.edit",
  "docs.generate",
  "reports.view",
  "journal.write",
  "discussions.post",
  "discussions.resolve",
  "knowledge.search",
  "knowledge.rate",
  "assistant.use",
  // Central Brain — everyone in the org can read + contribute
  "brain.read",
  "brain.ingest",
  "features.view",
  "features.vote",
  "meetings.view",
  "settings.view_own",
  "briefing.view",
  "dashboard.view",
  "emails.view",
  "tasks.view",
  "tasks.view_team",        // ops coordinates team tasks
  "tasks.edit",
  "tools.view",
  // Ops also coordinates external automation work — full automation set.
  "automations.view",
  "automations.run",
  "automations.override",
  "automations.resolve_exceptions",
  // Meeting-insights — Ops creates and manages org-shared feeds (the
  // recurring-meeting threads the team wants captured). View + manage
  // grants cover feed CRUD and ad-hoc poll. Export remains gated to
  // CEO/CTO so finance/legal-relevant attachment bytes don't fan out.
  "meetings.manage",
];

/** Dev: full dev surface + sites. No HR sensitive, no finance. */
const DEV: readonly Capability[] = [
  "docs.view",
  "docs.edit",
  "docs.generate",
  "reports.view",
  "journal.write",
  "journal.read_all",       // dev reviews team journals for context
  "discussions.post",
  "discussions.pin",        // dev pins architecture threads
  "discussions.resolve",
  "knowledge.search",
  "knowledge.rate",
  "assistant.use",
  // Central Brain — everyone in the org can read + contribute
  "brain.read",
  "brain.ingest",
  "features.view",
  "features.vote",
  "features.approve",       // dev leadership can approve feature requests
  "sites.view",
  "sites.deploy",           // dev-only by default
  "sites.edit",
  "meetings.view",          // dev gets read-only meetings (debugging routing/parsers)
  "settings.view_own",
  "briefing.view",
  "dashboard.view",
  "emails.view",
  "analytics.view",
  "tasks.view",
  "tasks.view_team",
  "tasks.edit",
  "tools.view",
  "tools.run",              // dev can run all tools
  // Dev needs read access to automations for troubleshooting parser
  // bugs. Override + resolve are intentionally NOT granted — those are
  // workflow decisions, not engineering decisions.
  "automations.view",
  "automations.run",
];

/** Designer: docs + knowledge + assistant; no finance, no HR, no deploys. */
const DESIGNER: readonly Capability[] = [
  "docs.view",
  "docs.generate",
  "knowledge.search",
  "knowledge.rate",
  "assistant.use",
  // Central Brain — everyone in the org can read + contribute
  "brain.read",
  "brain.ingest",
  "journal.write",
  "discussions.post",
  "features.view",
  "features.vote",
  "sites.view",             // designers review sites dashboard but can't deploy
  "meetings.view",
  "settings.view_own",
  "briefing.view",
  "dashboard.view",
  "tasks.view",
  "tasks.edit",
  "tools.view",
  "automations.view",        // designers see the automations dashboard read-only
];

const ROLE_MAP: Record<TeamRole, readonly Capability[]> = {
  cto: CTO,
  ceo: CEO,
  hr: HR,
  sales: SALES,
  ops: OPS,
  dev: DEV,
  designer: DESIGNER,
};

/**
 * True if `value` is a recognized TeamRole.
 */
export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ROLE_MAP, value);
}

/**
 * Default capabilities for a given role. Unknown roles return an empty set.
 * Caller should treat the result as immutable.
 */
export function capabilitiesForRole(role: string): ReadonlySet<Capability> {
  if (!isTeamRole(role)) return new Set<Capability>();
  return new Set(ROLE_MAP[role]);
}

/**
 * Exposed for tests + admin UI — full role→caps map.
 */
export function roleCapabilityTable(): Readonly<Record<TeamRole, ReadonlySet<Capability>>> {
  const out = {} as Record<TeamRole, ReadonlySet<Capability>>;
  for (const role of Object.keys(ROLE_MAP) as TeamRole[]) {
    out[role] = new Set(ROLE_MAP[role]);
  }
  return out;
}
