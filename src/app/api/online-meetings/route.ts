/**
 * POST /api/online-meetings — create a standalone Teams online meeting.
 *
 * Not tied to a calendar event. For calendar-linked meetings Tier 1's
 * calendar create path will (in a follow-up PR) consume the
 * `attachTeamsMeetingToEventInput` helper from
 * `@/lib/integrations/microsoft-online-meetings` with an opt-in
 * `createTeamsMeeting: true` flag. That wiring is NOT in this stream.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { createMeeting } from "@/lib/integrations/microsoft-online-meetings";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "invalid_json" },
      { status: 400 },
    );
  }

  const result = await createMeeting(
    user.id,
    {
      subject: typeof body?.subject === "string" ? body.subject : "",
      startAt: typeof body?.startAt === "string" ? body.startAt : "",
      endAt: typeof body?.endAt === "string" ? body.endAt : "",
      participants: Array.isArray(body?.participants) ? body.participants : undefined,
    },
    user.role,
  );

  if (!result.ok) {
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

  return NextResponse.json(
    {
      id: result.value.id,
      joinWebUrl: result.value.joinWebUrl,
      conferenceId: result.value.conferenceId,
    },
    { status: 201 },
  );
}
