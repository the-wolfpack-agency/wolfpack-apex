/**
 * GET /api/directory/users
 *
 * List cached tenant users with optional search + department filter.
 * Cache-first (never hits Graph on the hot path — use /api/directory/sync to
 * refresh).
 *
 * Query params:
 *   search     — substring over display_name / job_title / department / UPN / mail
 *   department — exact match
 *   cursor     — local UUID from a previous page's `nextCursor`
 *   limit      — 1..200, default 50
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { listUsers } from "@/lib/integrations/microsoft-directory";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const search = url.searchParams.get("search") ?? undefined;
  const department = url.searchParams.get("department") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  // internalOnly restricts results to the caller's own org domain — used by the
  // task assignee picker so it never surfaces the tenant's external guests. The
  // full Directory page omits it and still sees everyone.
  const internalOnly = url.searchParams.get("internalOnly") === "true";
  const emailDomain = internalOnly ? user.email.split("@")[1]?.toLowerCase() || undefined : undefined;

  const result = await listUsers(user.id, {
    search,
    department,
    cursor,
    emailDomain,
    top: Number.isFinite(limit) ? limit : undefined,
  });
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, max-age=30" },
  });
}
