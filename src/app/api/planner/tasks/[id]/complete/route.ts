/**
 * POST /api/planner/tasks/[id]/complete — mark a Planner task complete.
 * Body: { etag: string }
 *
 * Notifies the task's other assignees via `notify({ category:"tasks.completed", source:"planner" })`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { completeTask } from "@/lib/integrations/microsoft-planner";
import { recordAudit } from "@/lib/audit-log";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: { etag?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.etag || typeof body.etag !== "string") {
    return NextResponse.json({ error: "etag is required" }, { status: 400 });
  }

  const result = await completeTask(user.id, user.role, id, body.etag);
  if (!result.ok) {
    const status =
      result.code === "not_connected" ? 401 :
      result.code === "scope_missing" ? 403 :
      result.code === "not_found" ? 404 :
      result.code === "etag_conflict" ? 409 :
      result.code === "rate_limited" ? 429 :
      result.status ?? 502;
    return NextResponse.json(
      { error: result.code, scope: result.scope, message: result.message },
      {
        status,
        headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined,
      },
    );
  }
  // Route-boundary audit (the lib records the detailed before/after too).
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "planner.task.complete.requested",
    resourceType: "planner_task",
    resourceId: result.value.id,
  }).catch(() => undefined);

  return NextResponse.json({ task: result.value.task, id: result.value.id });
}
