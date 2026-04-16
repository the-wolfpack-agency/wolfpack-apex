/**
 * /api/calendar/events
 *
 *  GET  — list events in [?from, ?to], default next 7 days, ?limit (max 200)
 *  POST — create a new event
 *
 * meetings.schedule capability: not yet registered in
 * src/lib/auth/capabilities.ts. Until it is, we require plain auth and
 * rely on capability rollout to swap the gate in a follow-up PR without
 * breaking clients. See the commented requireCapability call below.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { createEvent, listEvents } from "@/lib/integrations/microsoft-calendar";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

  const events = await listEvents(user.id, {
    from: from || undefined,
    to: to || undefined,
    limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
  });

  trackEvent("system.page_viewed", user.id, user.role, {
    module: "calendar",
    endpoint: "events.list",
    count: events.length,
  });

  return NextResponse.json({ events });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "invalid_json" }, { status: 400 });
  }

  const result = await createEvent(user.id, {
    subject: typeof body?.subject === "string" ? body.subject : "",
    start: typeof body?.start === "string" ? body.start : "",
    end: typeof body?.end === "string" ? body.end : "",
    timeZone: typeof body?.timeZone === "string" ? body.timeZone : undefined,
    attendees: Array.isArray(body?.attendees) ? body.attendees : undefined,
    location: typeof body?.location === "string" ? body.location : undefined,
    bodyHtml: typeof body?.bodyHtml === "string" ? body.bodyHtml : undefined,
    bodyText: typeof body?.bodyText === "string" ? body.bodyText : undefined,
    isOnlineMeeting: body?.isOnlineMeeting === true,
    onlineMeetingProvider: body?.onlineMeetingProvider ?? undefined,
  }, user.role);

  if (!result.ok) {
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

  return NextResponse.json(
    { id: result.value.id, webLink: result.value.webLink },
    { status: 201 },
  );
}
