/**
 * GET /api/files — list OneDrive items (cache-miss triggers sync).
 *
 * Query params:
 *   parentId    — Graph id of the parent folder (default root)
 *   search      — full-text search on filename
 *   limit       — page size (1..200)
 *   cursor      — opaque Graph nextLink
 *   fromCache   — "true" to read mirror rows instead of hitting Graph
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  listDriveItems,
  listCachedFiles,
  GraphFilesError,
} from "@/lib/integrations/microsoft-files";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const parentId = url.searchParams.get("parentId") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitStr = url.searchParams.get("limit");
  const fromCache = url.searchParams.get("fromCache") === "true";

  const limit = limitStr ? parseInt(limitStr, 10) : 50;
  if (Number.isNaN(limit) || limit < 1 || limit > 200) {
    return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  }

  if (fromCache) {
    const items = await listCachedFiles(user.id, { limit, search });
    return NextResponse.json({ items, nextCursor: null, fromCache: true });
  }

  try {
    const res = await listDriveItems(user.id, { parentId, search, cursor, top: limit });
    if (res.scopeMissing) {
      return NextResponse.json(
        { error: "scope_missing", scope: res.scopeMissing, items: [], nextCursor: null },
        { status: 403 },
      );
    }
    return NextResponse.json({ items: res.items, nextCursor: res.nextCursor });
  } catch (err) {
    if (err instanceof GraphFilesError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 429) {
        return NextResponse.json(
          { error: "Microsoft Graph rate limit" },
          { status: 429, headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : undefined },
        );
      }
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
