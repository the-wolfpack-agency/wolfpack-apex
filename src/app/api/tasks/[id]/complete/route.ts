/**
 * POST /api/tasks/[id]/complete — mark a task as completed via Graph +
 * local cache. Emits system.task_completed analytics event.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getCachedTaskById,
  completeTask,
  GraphTasksError,
} from "@/lib/integrations/microsoft-tasks";
import { safeQuery } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const existing = await getCachedTaskById(user.id, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { rows } = await safeQuery<{ ms_list_id: string }>(
    `SELECT ms_list_id FROM instinct_task_lists WHERE id = $1 LIMIT 1`,
    [existing.listId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "List not found" }, { status: 404 });
  }

  try {
    const task = await completeTask(user.id, rows[0].ms_list_id, existing.msTaskId, "instinct");
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
