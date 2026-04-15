/**
 * `requireCapability` — single enforcement helper for every protected route.
 *
 * Usage:
 *
 *   export async function GET(req: NextRequest) {
 *     const auth = await requireCapability(req, "finance.reports.view");
 *     if (!auth.ok) return auth.response;
 *     const { user } = auth;
 *     ...
 *   }
 *
 * Also exported: `hasCapability(user, cap)` for UI / conditional rendering.
 *
 * Every denial emits `system.capability_denied` via the analytics pipeline.
 * Every successful check is silent (page_viewed etc. already fires).
 */

import { NextResponse } from "next/server";
import { getUserFromRequest, type TeamMember } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import type { Capability } from "./capabilities";
import {
  resolveCapabilities,
  loadUserOverrides,
  emptyOverrides,
  type CapabilityOverrides,
} from "./capability-overrides";
import { capabilitiesForRole } from "./role-capabilities";

export type RequireCapabilityResult =
  | { ok: true; user: TeamMember; capabilities: Set<Capability> }
  | { ok: false; response: NextResponse };

/**
 * Extract a coarse route identifier from a Request URL for analytics.
 * Keeps `/api/people/employees` but collapses dynamic `[id]` segments to `:id`.
 */
function routeOf(request: Request): string {
  try {
    const url = new URL(request.url);
    return url.pathname
      .replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, "/:id") // uuid-ish
      .replace(/\/\d+(?=\/|$)/g, "/:id");         // numeric id
  } catch {
    return "unknown";
  }
}

/**
 * Load effective capabilities for a user. Falls back to role defaults only
 * when no DB (shadow mode) or user has no overrides row.
 */
export async function effectiveCapabilitiesFor(user: TeamMember): Promise<{
  capabilities: Set<Capability>;
  overrides: CapabilityOverrides;
}> {
  const stored = await loadUserOverrides(user.id);
  const overrides = stored?.overrides ?? emptyOverrides();
  // Prefer role from DB if available, else the JWT's role claim
  const role = stored?.role ?? user.role;
  return {
    capabilities: resolveCapabilities(role, overrides),
    overrides,
  };
}

/**
 * Synchronous capability check when you already have the resolved set or
 * a user whose role defaults you trust (no overrides applied). Primarily
 * used for UI hiding where `loadUserOverrides` is too expensive / async.
 */
export function hasCapability(
  user: Pick<TeamMember, "role"> | null | undefined,
  capability: Capability,
  overrides?: CapabilityOverrides,
): boolean {
  if (!user) return false;
  const caps = overrides
    ? resolveCapabilities(user.role, overrides)
    : new Set<Capability>(capabilitiesForRole(user.role));
  return caps.has(capability);
}

/**
 * Route enforcement. Always returns — never throws. Emits
 * `system.capability_denied` on every 401/403.
 */
export async function requireCapability(
  request: Request,
  capability: Capability,
): Promise<RequireCapabilityResult> {
  const route = routeOf(request);
  const user = getUserFromRequest(request.headers.get("authorization"));

  if (!user) {
    trackEvent("system.capability_denied", "anonymous", "anonymous", {
      capability,
      role: "anonymous",
      user_id: "anonymous",
      route,
    });
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized", capability }, { status: 401 }),
    };
  }

  const { capabilities } = await effectiveCapabilitiesFor(user);
  if (!capabilities.has(capability)) {
    trackEvent("system.capability_denied", user.id, user.role, {
      capability,
      role: user.role,
      user_id: user.id,
      route,
    });
    return {
      ok: false,
      response: NextResponse.json({ error: "forbidden", capability }, { status: 403 }),
    };
  }

  return { ok: true, user, capabilities };
}
