/**
 * GET /api/meetings           — list recent ingested meeting transcripts
 * GET /api/meetings?id=...    — fetch one transcript with full text
 *
 * Org-shared: every authenticated team member sees every meeting.
 * owner_user_id is preserved on every row so we can switch to
 * per-user scoping later without re-ingesting.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { listMeetingTranscripts, getMeetingTranscript } from "@/lib/plaud";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const transcript = await getMeetingTranscript(id);
    if (!transcript) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    trackEvent("system.page_viewed", user.id, user.role, {
      page: "meeting_detail",
      meeting_id: id,
      module: "plaud",
    });
    return NextResponse.json({ transcript });
  }

  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam || "50", 10) || 50, 1), 200);

  const transcripts = await listMeetingTranscripts(limit);
  trackEvent("system.page_viewed", user.id, user.role, {
    page: "meetings",
    count: transcripts.length,
    module: "plaud",
  });
  return NextResponse.json({ transcripts });
}
