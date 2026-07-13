/**
 * PATCH /api/tasks/[id] — update a cached task. `id` is the local UUID;
 * we look up the corresponding MS task id + list id from the cache and
 * write-through to Graph.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  getCachedTaskById,
  updateTask,
  deleteTask,
  validateOutlookTaskFields,
  GraphTasksError,
  TaskStatus,
  TaskImportance,
} from "@/lib/integrations/microsoft-tasks";

const VALID_STATUS: TaskStatus[] = [
  "notStarted",
  "inProgress",
  "completed",
  "waitingOnOthers",
  "deferred",
];
const VALID_IMPORTANCE: TaskImportance[] = ["low", "normal", "high"];

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const task = await getCachedTaskById(user.id, id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  trackEvent("system.task_viewed", user.id, user.role, {
    task_id: task.msTaskId,
    list_id: task.listId,
  });
  return NextResponse.json({ task });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const existing = await getCachedTaskById(user.id, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: {
    title?: string; body?: string; dueAt?: string | null;
    startAt?: string | null; reminderAt?: string | null;
    isReminderOn?: boolean; categories?: string[];
    importance?: TaskImportance; status?: TaskStatus;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.status && !VALID_STATUS.includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (body.importance && !VALID_IMPORTANCE.includes(body.importance)) {
    return NextResponse.json({ error: "Invalid importance" }, { status: 400 });
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    return NextResponse.json({ error: "Invalid title" }, { status: 400 });
  }
  const fieldErr = validateOutlookTaskFields(body);
  if (fieldErr) return NextResponse.json({ error: fieldErr }, { status: 400 });

  try {
    // Find the MS list id for this task.
    // existing.listId is the local UUID; we need its ms_list_id via cache.
    const task = await updateTask(
      user.id,
      await lookupMsListId(existing.listId),
      existing.msTaskId,
      {
        title: body.title,
        body: body.body,
        dueAt: body.dueAt,
        startAt: body.startAt,
        reminderAt: body.reminderAt,
        isReminderOn: body.isReminderOn,
        categories: body.categories,
        importance: body.importance,
        status: body.status,
      },
    );
    return NextResponse.json({ task });
  } catch (err) {
    if (err instanceof GraphTasksError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 429) {
        return NextResponse.json({ error: "Microsoft Graph rate limit" }, {
          status: 429,
          headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : undefined,
        });
      }
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const existing = await getCachedTaskById(user.id, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await deleteTask(
      user.id,
      await lookupMsListId(existing.listId),
      existing.msTaskId,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof GraphTasksError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

async function lookupMsListId(localListId: string): Promise<string> {
  const { safeQuery } = await import("@/lib/db");
  const { rows } = await safeQuery<{ ms_list_id: string }>(
    `SELECT ms_list_id FROM instinct_task_lists WHERE id = $1 LIMIT 1`,
    [localListId],
  );
  if (rows.length === 0) throw new Error("List not found in cache");
  return rows[0].ms_list_id;
}
