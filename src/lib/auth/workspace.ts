/**
 * resolveWorkspace - the single chokepoint for turning an authenticated user's
 * (possibly absent) workspace into the id every scoped query keys on.
 *
 * WHY THIS EXISTS: ~30 routes did `auth.user.workspaceId ?? "default"` inline. In
 * the current single-tenant deployment "default" is the real workspace, so that
 * fallback is correct THERE - but scattered + SILENT, it is exactly how a
 * multi-tenant deployment would coalesce two tenants into one shared bucket
 * without anyone noticing. Centralizing it makes the tenant boundary one
 * auditable decision instead of 30 copies, and lets a strict deployment fail
 * CLOSED with one env flag instead of a 30-file edit.
 *
 * Behavior (safe-by-default, strict-by-choice):
 *   - workspace present            -> use it (the overwhelming common path).
 *   - absent, strict mode OFF      -> use FACTORY_DEFAULT_WORKSPACE || "default"
 *                                     (preserves today's single-tenant behavior).
 *   - absent, REQUIRE_EXPLICIT_WORKSPACE=true -> throw WorkspaceRequiredError, so
 *                                     a multi-tenant deployment denies rather than
 *                                     pools. Routes map this to a 400.
 */
export class WorkspaceRequiredError extends Error {
  constructor() {
    super("No workspace is bound to this session, and strict isolation (REQUIRE_EXPLICIT_WORKSPACE) is enabled.");
    this.name = "WorkspaceRequiredError";
  }
}

export function resolveWorkspace(workspaceId: string | null | undefined): string {
  if (workspaceId) return workspaceId;
  if (process.env.REQUIRE_EXPLICIT_WORKSPACE === "true") throw new WorkspaceRequiredError();
  return process.env.FACTORY_DEFAULT_WORKSPACE || "default";
}
