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
import { cookies } from "next/headers";
import {
  getUserFromRequest,
  verifyToken,
  DEFAULT_WORKSPACE_ID,
  type TeamMember,
} from "@/lib/auth";
import { ACCESS_TOKEN_COOKIE } from "@/lib/crypto/cookies";
import { trackEvent } from "@/lib/analytics";
import type { Capability } from "./capabilities";
import {
  resolveCapabilities,
  loadUserOverrides,
  emptyOverrides,
  type CapabilityOverrides,
} from "./capability-overrides";
import { capabilitiesForRole } from "./role-capabilities";
import { mfaRequirementFor, readCookie } from "./mfa";
import { MFA_PROOF_COOKIE } from "@/lib/crypto/mfa-proof";
import { bindRequestWorkspace } from "@/lib/db/request-workspace";

/** Exemption uses are reported at most once per user per hour per process. */
const exemptionReported = new Map<string, number>();
const EXEMPTION_REPORT_MS = 60 * 60 * 1000;

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
/** Resolve the caller from the HttpOnly access-token cookie. Used as
 *  the fallback when a request arrives without an Authorization header
 *  — i.e. a browser navigation to an admin route (OAuth start, snapshot
 *  download links). The same JWT shape is in both, so behavior is
 *  identical once the user is constructed. */
async function userFromCookie(): Promise<TeamMember | null> {
  try {
    const jar = await cookies();
    const token = jar.get(ACCESS_TOKEN_COOKIE)?.value;
    if (!token) return null;
    const payload = verifyToken(token);
    return {
      id: payload.userId,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      workspaceId: payload.workspaceId ?? DEFAULT_WORKSPACE_ID,
      created_at: "",
    };
  } catch {
    return null;
  }
}

export async function requireCapability(
  request: Request,
  capability: Capability,
): Promise<RequireCapabilityResult> {
  const route = routeOf(request);
  /* Header first (Bearer token from JS clients), cookie fallback (browser
     navigations like OAuth /start). Either path yields the same TeamMember
     shape so downstream capability checks don't fork. */
  const user =
    getUserFromRequest(request.headers.get("authorization")) ??
    (await userFromCookie());

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

  /* RLS SESSION CONTEXT. Bind the caller's VERIFIED workspace (from the JWT,
     never from request input) for the rest of this request, so query() can set
     app.workspace_id once INSTINCT_RLS_SESSION_CONTEXT is on. A no-op while
     the flag is off. Bound before the MFA gate because that gate reads
     instinct_admin_mfa, which carries a workspace policy (migration 296). */
  bindRequestWorkspace(user.workspaceId);

  /* ADMIN MFA GATE. Admin-capable callers (effective `settings.manage_team`)
     must hold a confirmed enrollment and a valid MFA proof for this browser.
     The MFA routes themselves (`account.manage_mfa`) are always reachable so
     an admin can enroll or answer the challenge; see src/lib/auth/mfa.ts for
     the whole contract. Runs AFTER the capability check so a plain 403 for a
     missing capability is unchanged. */
  if (capability !== "account.manage_mfa") {
    const decision = await mfaRequirementFor({
      user,
      capabilities,
      proofToken: readCookie(request, MFA_PROOF_COOKIE) ?? (await proofFromCookieJar()),
    });
    if (decision.exempt) {
      const last = exemptionReported.get(user.id) ?? 0;
      if (Date.now() - last > EXEMPTION_REPORT_MS) {
        exemptionReported.set(user.id, Date.now());
        trackEvent("auth.mfa_exemption_applied", user.id, user.role, { capability, route });
      }
    }
    if (decision.required === "unavailable") {
      return {
        ok: false,
        response: NextResponse.json({ error: "mfa_check_unavailable", capability }, { status: 503 }),
      };
    }
    if (decision.required) {
      trackEvent("auth.mfa_enforcement_blocked", user.id, user.role, {
        reason: decision.required,
        capability,
        route,
      });
      return {
        ok: false,
        response: NextResponse.json(
          { error: "mfa_required", mfa: decision.required, capability },
          { status: 403 },
        ),
      };
    }
  }

  return { ok: true, user, capabilities };
}

/** Cookie-jar fallback for the proof (route handlers given a bare Request). */
async function proofFromCookieJar(): Promise<string | null> {
  try {
    const jar = await cookies();
    return jar.get(MFA_PROOF_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}
