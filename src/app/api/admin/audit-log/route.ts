/**
 * GET /api/admin/audit-log
 *
 * Paginated, filterable audit log viewer for compliance officers.
 *
 * Auth: role `ceo`/`cto` OR capability `admin.audit_log.view` (whichever
 * lands first; supporting both avoids hard-coupling to the capability stream).
 *
 * Query params:
 *   actor_user_id
 *   resource_type
 *   resource_id
 *   action
 *   since          ISO-8601
 *   until          ISO-8601
 *   limit          default 50, max 500
 *   cursor         opaque, from previous response
 *
 * Emits `system.audit_log_viewed` on success.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { queryAuditLog } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { effectiveCapabilitiesFor } from "@/lib/auth/require-capability";
import type { Capability } from "@/lib/auth/capabilities";

const AUDIT_CAPABILITY = "admin.audit_log.view" as Capability;

async function checkAuth(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return { ok: false as const, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (user.role === "ceo" || user.role === "cto" || user.role === "evp") {
    return { ok: true as const, user };
  }
  try {
    const { capabilities } = await effectiveCapabilitiesFor(user);
    if (capabilities.has(AUDIT_CAPABILITY)) {
      return { ok: true as const, user };
    }
  } catch {
    // capability stream may not be available — fall through to deny
  }
  return {
    ok: false as const,
    response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  };
}

export async function GET(req: NextRequest) {
  const auth = await checkAuth(req);
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const params = req.nextUrl.searchParams;
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  const sinceStr = params.get("since");
  const untilStr = params.get("until");

  const page = await queryAuditLog({
    actorUserId: params.get("actor_user_id") ?? undefined,
    resourceType: params.get("resource_type") ?? undefined,
    resourceId: params.get("resource_id") ?? undefined,
    action: params.get("action") ?? undefined,
    since: sinceStr ? new Date(sinceStr) : undefined,
    until: untilStr ? new Date(untilStr) : undefined,
    limit,
    cursor: params.get("cursor") ?? undefined,
  });

  trackEvent("system.audit_log_viewed", user.id, user.role, {
    count: page.entries.length,
    filters_applied:
      Number(Boolean(params.get("actor_user_id"))) +
      Number(Boolean(params.get("resource_type"))) +
      Number(Boolean(params.get("resource_id"))) +
      Number(Boolean(params.get("action"))) +
      Number(Boolean(sinceStr)) +
      Number(Boolean(untilStr)),
  });

  return NextResponse.json(page);
}
