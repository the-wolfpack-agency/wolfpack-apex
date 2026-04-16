/**
 * PATCH /api/planner/tasks/[id] — update a Planner task.
 *
 * `id` accepts local UUID OR Graph task id. Graph requires an If-Match
 * header for PATCH — the caller MUST send `etag` in the body (from the
 * cached task). 412 Precondition Failed maps to 409 `etag_conflict` so
 * the UI can refetch and retry.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getTask, updateTask } from "@/lib/integrations/microsoft-planner";
import { recordAudit } from "@/lib/audit-log";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const task = await getTask(user.id, id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ task });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  let body: {
    title?: string; dueAt?: string | null; bucketId?: string | null;
    assignees?: string[]; priority?: number; percentComplete?: number;
    etag?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.etag || typeof body.etag !== "string") {
    return NextResponse.json({ error: "etag is required" }, { status: 400 });
  }
  if (body.percentComplete !== undefined && (typeof body.percentComplete !== "number" ||
       body.percentComplete < 0 || body.percentComplete > 100)) {
    return NextResponse.json({ error: "percentComplete must be 0..100" }, { status: 400 });
  }
  if (body.priority !== undefined && (typeof body.priority !== "number" ||
       body.priority < 0 || body.priority > 10)) {
    return NextResponse.json({ error: "priority must be 0..10" }, { status: 400 });
  }

  const result = await updateTask(user.id, user.role, id, {
    title: body.title,
    dueAt: body.dueAt,
    bucketId: body.bucketId,
    assignees: body.assignees,
    priority: body.priority,
    percentComplete: body.percentComplete,
  }, body.etag);

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
  // Route-boundary audit (the lib records detailed before/after too).
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "planner.task.update.requested",
    resourceType: "planner_task",
    resourceId: result.value.id,
    afterState: { fields: Object.keys(body).filter((k) => k !== "etag") },
  }).catch(() => undefined);

  return NextResponse.json({ task: result.value.task, id: result.value.id });
}
