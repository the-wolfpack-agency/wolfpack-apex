/**
 * /api/tasks
 *
 * GET  — list caller's tasks from the local Postgres cache (never Graph).
 *        Query params: status, listId, dueBefore, dueAfter, search, limit, cursor.
 * POST — create a task (write-through to Graph + cache).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  listCachedTasks,
  createTask,
  resolveDefaultListId,
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

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const listId = url.searchParams.get("listId");
  const dueBefore = url.searchParams.get("dueBefore");
  const dueAfter = url.searchParams.get("dueAfter");
  const search = url.searchParams.get("search");
  const limitStr = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  if (status && !VALID_STATUS.includes(status as TaskStatus)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { tasks, nextCursor } = await listCachedTasks(user.id, {
    status: (status as TaskStatus) || undefined,
    listId: listId || undefined,
    dueBefore: dueBefore || undefined,
    dueAfter: dueAfter || undefined,
    search: search || undefined,
    limit: limitStr ? parseInt(limitStr, 10) : undefined,
    cursor: cursor || undefined,
  });

  return NextResponse.json({ tasks, nextCursor });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    listId?: string; title?: string; body?: string;
    dueAt?: string | null; importance?: TaskImportance;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // listId is OPTIONAL: when omitted we create in the user's default To Do list
  // so a task can be created with just a title (no forced list pick).
  const explicitListId = typeof body.listId === "string" ? body.listId.trim() : "";
  if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (body.importance && !VALID_IMPORTANCE.includes(body.importance)) {
    return NextResponse.json({ error: "Invalid importance" }, { status: 400 });
  }

  try {
    const listId = explicitListId || (await resolveDefaultListId(user.id));
    const task = await createTask(user.id, listId, {
      title: body.title.trim(),
      body: body.body,
      dueAt: body.dueAt ?? undefined,
      importance: body.importance,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    if (err instanceof GraphTasksError) {
      trackEvent("system.ms_tasks_sync_failed", user.id, user.role, {
        user_id: user.id,
        error: err.message,
        http_status: err.status,
      });
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
