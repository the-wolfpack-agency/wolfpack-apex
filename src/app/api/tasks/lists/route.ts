/**
 * GET /api/tasks/lists — list caller's task lists from the local cache.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listCachedTaskLists } from "@/lib/integrations/microsoft-tasks";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lists = await listCachedTaskLists(user.id);
  return NextResponse.json({ lists });
}
