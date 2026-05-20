/**
 * /api/time-entries
 *
 * POST — log a time entry (caller is the user, workspace-scoped).
 * GET  — list the caller's own entries, optional ?since / ?until / ?limit.
 *
 * Both require an authenticated user.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { recordTimeEntry, listTimeEntries } from "@/lib/time-entries";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    job_code?: string;
    hours?: number;
    notes?: string;
    logged_for_date?: string;
  } | null;
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

  try {
    const entry = await recordTimeEntry({
      workspaceId: user.workspaceId,
      userId: user.id,
      userEmail: user.email,
      userRole: user.role,
      jobCode: body.job_code ?? "",
      hours: Number(body.hours),
      notes: body.notes,
      loggedForDate: body.logged_for_date,
    });
    return NextResponse.json({ ok: true, entry }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "could not log time" },
      { status: 400 },
    );
  }
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const entries = await listTimeEntries({
    workspaceId: user.workspaceId,
    userId: user.id,
    since: url.searchParams.get("since") || undefined,
    until: url.searchParams.get("until") || undefined,
    limit: Number(url.searchParams.get("limit") || 200),
  });
  return NextResponse.json({ entries, count: entries.length });
}
