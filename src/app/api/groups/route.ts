/**
 * GET /api/groups — list the caller's M365 groups from local cache.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listMyGroups } from "@/lib/integrations/microsoft-groups";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const limitStr = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const search = url.searchParams.get("search");

  const result = await listMyGroups(user.id, {
    limit: limitStr ? parseInt(limitStr, 10) : undefined,
    cursor: cursor || undefined,
    search: search || undefined,
  });

  trackEvent("system.page_viewed", user.id, user.role, { endpoint: "groups.list", count: result.groups.length });

  return NextResponse.json(result);
}
