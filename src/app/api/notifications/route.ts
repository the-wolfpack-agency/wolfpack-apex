/**
 * GET /api/notifications — list the caller's notifications.
 *
 * Query:
 *   ?category=...
 *   ?priority=...
 *   ?read=all|read|unread   (default: all)
 *   ?search=...              (ILIKE on title+body)
 *   ?cursor=ISO timestamp    (pagination)
 *   ?limit=20                (max 100)
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listAll } from "@/lib/notifications/in-app";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const category = url.searchParams.get("category") ?? undefined;
  const priority = url.searchParams.get("priority") ?? undefined;
  const readStateRaw = url.searchParams.get("read") ?? "all";
  const readState =
    readStateRaw === "read" || readStateRaw === "unread" ? readStateRaw : "all";
  const search = url.searchParams.get("search") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.max(1, Math.min(100, Number(limitRaw))) : 20;

  const result = await listAll(user.id, {
    cursor,
    limit,
    filter: { category, priority, readState, search },
  });

  return NextResponse.json(result);
}
