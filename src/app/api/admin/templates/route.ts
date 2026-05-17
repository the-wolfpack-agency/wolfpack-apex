/**
 * GET /api/admin/templates
 *
 * Admin-gated read of the integration template registry. Used by the
 * /admin/insights dashboard to render "every widget/form, what tool
 * it mirrors, what use cases it enables, when it last drifted."
 *
 * Auth: cto / ceo / evp roles.
 *
 * Query params:
 *   vendor   filter by vendor (microsoft / salesforce / hubspot / ...)
 *   surface  filter by surface ("widget" | "form" | "page_facts")
 *   includeRetired   set to "true" to include is_active=false rows
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  listIntegrationTemplates,
  type TemplateSurface,
} from "@/lib/templates/registry";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto" && user.role !== "evp") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const vendor = params.get("vendor") || undefined;
  const surfaceRaw = params.get("surface");
  const surface: TemplateSurface | undefined =
    surfaceRaw === "widget" || surfaceRaw === "form" || surfaceRaw === "page_facts"
      ? surfaceRaw
      : undefined;
  const activeOnly = params.get("includeRetired") !== "true";

  const templates = await listIntegrationTemplates({ vendor, surface, activeOnly });
  trackEvent("system.audit_log_viewed", user.id, user.role, {
    view: "templates.registry",
    result_count: templates.length,
    vendor: vendor ?? "(any)",
  });

  return NextResponse.json({
    count: templates.length,
    templates,
  });
}
