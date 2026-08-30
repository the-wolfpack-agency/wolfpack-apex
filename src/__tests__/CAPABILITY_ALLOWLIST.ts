/**
 * Explicit allowlist of API route files that are NOT required to call
 * `requireCapability()` — typically public endpoints (auth, webhooks,
 * health checks) or routes owned by a separate stream that enforces
 * authorization through a different primitive.
 *
 * Adding to this list is a deliberate act — the coverage test prints the
 * list every run so reviewers can see what's unguarded.
 *
 * Paths are relative to the repo root and POSIX-style.
 */

export const CAPABILITY_ALLOWLIST: readonly string[] = [
  // Public auth endpoints — login issues the JWT, refresh validates it.
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/refresh/route.ts",

  // Invite-token accept: gated by a signed one-time token, not a JWT.
  "src/app/api/team/accept/route.ts",

  // Browser-posted CSP reports: public, rate-limited in middleware.
  "src/app/api/csp-report/route.ts",

  // /api/me endpoints: any logged-in user reads their own caps.
  "src/app/api/me/capabilities/route.ts",

  // Admin digest trigger: owned by the notifications stream; gated in
  // that stream via role check. Registered here so this stream doesn't
  // have to touch notifications code. The notifications stream is
  // responsible for migrating it to `requireCapability(..., 'admin.*')`.
  "src/app/api/admin/notifications/trigger-digest/route.ts",

  // Audit log routes: owned by the audit-log stream; gated via its own
  // primitive. Will be migrated to `requireCapability('admin.audit_log.view')`
  // by that stream.
  "src/app/api/admin/audit-log/export/route.ts",
  "src/app/api/admin/audit-log/route.ts",
  "src/app/api/admin/audit-log/verify/route.ts",

  // OAuth provider callback: no session capability gate by design. The
  // signed HMAC state token (workspace, provider, nonce, exp) is verified
  // here and implicitly proves the requester passed the /start route's
  // settings.manage_team check. There is no JWT on a provider redirect.
  "src/app/api/admin/connectors/oauth/[provider]/callback/route.ts",

  // Admin insights + registry reads: authenticate the caller inline via
  // getUserFromRequest + an explicit ceo/cto/evp role check (the same
  // inline admin pattern used across the insights/* surface). Not gated by
  // requireCapability, but genuinely authorized.
  "src/app/api/admin/insights/unmet-intents/route.ts",
  "src/app/api/admin/insights/role-mismatches/route.ts",
  "src/app/api/admin/insights/capability/route.ts",
  // Read-only pipeline health: same inline admin role gate as insights/*.
  "src/app/api/admin/brain/health/route.ts",
  "src/app/api/admin/insights/routing-coverage/route.ts",
  "src/app/api/admin/insights/degradation/route.ts",
  "src/app/api/admin/templates/route.ts",

  // Provision health bot: authenticates inline via getUserFromRequest +
  // an explicit ceo/cto-only role check before minting the service token.
  // Real auth via the same inline admin pattern as the insights routes.
  "src/app/api/admin/provision-health-bot/route.ts",

  // MS Tasks routes: owned by the tasks stream (migration 018). Should
  // migrate to `requireCapability('tasks.*')` when that stream lands.
  "src/app/api/tasks/[id]/complete/route.ts",
  "src/app/api/tasks/[id]/route.ts",
  "src/app/api/tasks/lists/route.ts",
  "src/app/api/tasks/route.ts",
  "src/app/api/tasks/sync/route.ts",
  "src/app/api/tasks/webhook/route.ts",
];

/**
 * True if the given normalized path is allowlisted. Case-sensitive
 * because route paths on POSIX filesystems are.
 */
export function isAllowlisted(pathFromRoot: string): boolean {
  return CAPABILITY_ALLOWLIST.includes(pathFromRoot);
}
