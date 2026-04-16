/**
 * GET /api/planner/plans/[id]/tasks — list tasks for a plan (cache).
 *
 * Filters:
 *   - percent_complete=0|50|100
 *   - assigneeUserId=<graph user id>
 *   - dueBefore / dueAfter (ISO)
 *   - search=<substring on title>
 *   - limit=<1..200>, cursor=<task UUID>
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listTasks } from "@/lib/integrations/microsoft-planner";
import { trackEvent } from "@/lib/analytics";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const url = new URL(req.url);

  const percentStr = url.searchParams.get("percent_complete");
  const percent = percentStr !== null ? parseInt(percentStr, 10) : undefined;
  if (percent !== undefined && (isNaN(percent) || percent < 0 || percent > 100)) {
    return NextResponse.json({ error: "Invalid percent_complete" }, { status: 400 });
  }

  const result = await listTasks(user.id, id, {
    percentComplete: percent,
    assigneeUserId: url.searchParams.get("assigneeUserId") ?? undefined,
    dueBefore: url.searchParams.get("dueBefore") ?? undefined,
    dueAfter: url.searchParams.get("dueAfter") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });

  if (!result.ok) {
    const status =
      result.code === "not_connected" ? 401 :
      result.code === "not_found" ? 404 :
      result.status ?? 502;
    return NextResponse.json(
      { error: result.code, message: result.message },
      { status },
    );
  }

  trackEvent("system.page_viewed", user.id, user.role, {
    endpoint: "planner.tasks",
    plan_id: id,
    count: result.value.tasks.length,
  });
  return NextResponse.json(result.value);
}
