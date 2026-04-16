/**
 * /api/calendar/events/[id]
 *
 *  PATCH  — update an event (partial)
 *  DELETE — destructive; requires ?confirm=true to prevent accidental drops.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { updateEvent, deleteEvent } from "@/lib/integrations/microsoft-calendar";

function mapError(result: Extract<Awaited<ReturnType<typeof updateEvent>>, { ok: false }>) {
  switch (result.code) {
    case "invalid_input":
      return NextResponse.json(
        { error: "invalid_input", detail: result.message ?? "invalid" },
        { status: 400 },
      );
    case "scope_missing":
      return NextResponse.json(
        { error: "forbidden", code: "scope_missing", scope: result.scope ?? "Calendars.ReadWrite" },
        { status: 403 },
      );
    case "rate_limited":
      return NextResponse.json(
        { error: "rate_limited", retryAfter: result.retryAfter ?? 60 },
        { status: 429, headers: { "Retry-After": String(result.retryAfter ?? 60) } },
      );
    case "not_connected":
      return NextResponse.json({ error: "microsoft_not_connected" }, { status: 401 });
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "graph_error":
      return NextResponse.json(
        { error: "graph_error", status: result.status, detail: result.message },
        { status: 502 },
      );
    default:
      return NextResponse.json({ error: "internal", detail: result.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = params.id;
  if (!id) return NextResponse.json({ error: "invalid_input", detail: "missing_id" }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "invalid_json" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body?.subject === "string") patch.subject = body.subject;
  if (typeof body?.start === "string") patch.start = body.start;
  if (typeof body?.end === "string") patch.end = body.end;
  if (typeof body?.timeZone === "string") patch.timeZone = body.timeZone;
  if (Array.isArray(body?.attendees)) patch.attendees = body.attendees;
  if (typeof body?.location === "string") patch.location = body.location;
  if (typeof body?.bodyHtml === "string") patch.bodyHtml = body.bodyHtml;
  if (typeof body?.bodyText === "string") patch.bodyText = body.bodyText;
  if (typeof body?.isOnlineMeeting === "boolean") patch.isOnlineMeeting = body.isOnlineMeeting;
  if (body?.onlineMeetingProvider !== undefined) patch.onlineMeetingProvider = body.onlineMeetingProvider;

  const result = await updateEvent(user.id, id, patch as any, user.role);
  if (!result.ok) return mapError(result);
  return NextResponse.json({ id: result.value.id });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = params.id;
  if (!id) return NextResponse.json({ error: "invalid_input", detail: "missing_id" }, { status: 400 });

  const url = new URL(req.url);
  const confirm = url.searchParams.get("confirm");
  if (confirm !== "true") {
    return NextResponse.json(
      { error: "confirmation_required", detail: "append ?confirm=true to delete" },
      { status: 400 },
    );
  }

  const result = await deleteEvent(user.id, id, user.role);
  if (!result.ok) {
    return mapError(result as Extract<typeof result, { ok: false }>);
  }
  return NextResponse.json({ ok: true });
}
