/**
 * /api/online-meetings/[id]
 *
 *   GET   — fetch a meeting (read-through Graph→cache)
 *   PATCH — update meeting subject / start / end / participants
 *
 * Delete is intentionally omitted — Graph's /me/onlineMeetings doesn't
 * support DELETE on one-off meetings via delegated scopes in a way that
 * matches the calendar event lifecycle Tier 1 owns. Meetings are cleaned
 * up when their linked event is deleted.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getMeeting,
  updateMeeting,
} from "@/lib/integrations/microsoft-online-meetings";

function mapError(
  result: Extract<Awaited<ReturnType<typeof updateMeeting>>, { ok: false }>,
) {
  switch (result.code) {
    case "invalid_input":
      return NextResponse.json(
        { error: "invalid_input", detail: result.message ?? "invalid" },
        { status: 400 },
      );
    case "scope_missing":
      return NextResponse.json(
        {
          error: "forbidden",
          code: "scope_missing",
          scope: result.scope ?? "OnlineMeetings.ReadWrite.All",
        },
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
      return NextResponse.json(
        { error: "internal", detail: result.message },
        { status: 500 },
      );
  }
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = ctx.params?.id;
  if (!id) {
    return NextResponse.json(
      { error: "invalid_input", detail: "missing_id" },
      { status: 400 },
    );
  }

  const meeting = await getMeeting(user.id, id);
  if (!meeting) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ meeting });
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = ctx.params?.id;
  if (!id) {
    return NextResponse.json(
      { error: "invalid_input", detail: "missing_id" },
      { status: 400 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "invalid_json" },
      { status: 400 },
    );
  }

  const patch: Record<string, unknown> = {};
  if (typeof body?.subject === "string") patch.subject = body.subject;
  if (typeof body?.startAt === "string") patch.startAt = body.startAt;
  if (typeof body?.endAt === "string") patch.endAt = body.endAt;
  if (Array.isArray(body?.participants)) patch.participants = body.participants;

  const result = await updateMeeting(user.id, id, patch as any, user.role);
  if (!result.ok) return mapError(result);
  return NextResponse.json({ id: result.value.id });
}
