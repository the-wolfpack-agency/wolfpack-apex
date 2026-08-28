/**
 * POST /api/admin/platform-scans/assess
 *
 * Assess a client's live system from access they granted, rather than from
 * their source code.
 *
 * THE ENGAGEMENT THIS SERVES. A client grants access to systems they run: a
 * website, a portal, a tenant. They do not hand over a repository, and asking
 * for one on day one is the wrong first conversation. The existing engagement
 * sweep starts from a GitHub owner and repo and silently skips anything
 * without one, so it could never assess the systems an engagement actually
 * begins with.
 *
 * OWNERSHIP IS CHECKED INSIDE THE ASSESSMENT, not here, and deliberately so.
 * A guard on the route protects the route; a guard in the function protects
 * every caller of it, including the scheduled sweep and any agent operation
 * added later. Putting it here as well would be a second copy that can drift
 * from the first.
 *
 * Returns 200 with a refusal in the body rather than an error status when the
 * target is unverified or unreachable. That is not a failed request: the
 * assessment ran and its answer was "I will not scan this", which the caller
 * needs to read and show. A 403 would make it look like the operator lacked
 * permission, which is a different problem with a different fix.
 *
 * Capability: settings.manage_team, matching the rest of the platform-scan
 * admin surface.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit } from "@/lib/audit-log";
import { runClientAssessment } from "@/lib/platform-scan/engage/client-assessment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: { platform?: unknown; base_url?: unknown; access?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "body must be JSON" },
      { status: 400 },
    );
  }

  const platform = typeof body.platform === "string" ? body.platform.trim() : "";
  const baseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
  if (!platform || !baseUrl) {
    return NextResponse.json(
      { error: "invalid_input", detail: "platform and base_url are required" },
      { status: 400 },
    );
  }

  /* Parsed rather than trusted. A malformed address should fail here, with a
     sentence somebody can act on, rather than inside the fetcher. */
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported scheme");
    }
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "base_url must be an http or https address" },
      { status: 400 },
    );
  }

  /* CREDENTIALS THE CLIENT GRANTED, and they are optional on purpose. A first
     pass usually runs anonymously, and requiring credentials up front would
     mean asking to be trusted with them before there is any reason to be.

     Read from the request and used for this run only. Nothing here stores
     them: a scan that quietly retains a client's password is a liability that
     outlives the engagement. */
  const rawAccess = body.access as Record<string, unknown> | undefined;
  const access =
    rawAccess &&
    typeof rawAccess.login_path === "string" &&
    typeof rawAccess.username === "string" &&
    typeof rawAccess.password === "string"
      ? {
          loginPath: rawAccess.login_path,
          username: rawAccess.username,
          password: rawAccess.password,
          ...(typeof rawAccess.session_cookie_name === "string"
            ? { sessionCookieName: rawAccess.session_cookie_name }
            : {}),
        }
      : undefined;

  const result = await runClientAssessment({
    workspaceId: user.workspaceId ?? "default",
    platform,
    baseUrl,
    actor: { userId: user.id, role: user.role },
    ...(access ? { access } : {}),
  });

  /* AUDITED BECAUSE IT REACHES SOMEBODY ELSE'S SYSTEM. "Who pointed us at that
     host, and when" is the first question asked if a client ever queries
     traffic they did not expect, and a refusal is worth recording for the same
     reason: it is evidence the floor held. */
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.client_assessment_run",
    resourceType: "platform_scan",
    /* THE CREDENTIALS ARE NEVER WRITTEN. That a signed-in scan happened is the
       auditable fact; the password is not, and an audit log holding one is a
       permanent copy of a client's secret in the one table designed never to
       be edited. */
    afterState: {
      platform,
      base_url: baseUrl,
      refused: result.refused ?? null,
      authenticated: result.authenticated,
      routes: result.routesDiscovered,
      internal_surfaces: result.internalSurfaces,
      findings: result.findingCount,
    },
  }).catch(() => undefined);

  return NextResponse.json(
    { assessment: result },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
