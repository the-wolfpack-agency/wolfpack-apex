/**
 * GET /api/meetings/feeds/[slug]/messages/[messageId]/attachments/[attachmentId]/download
 *
 * Stream B owns the IMPLEMENTATION of byte-streaming + content-disposition
 * + correct mime + audit. This file is a Stream A stub that:
 *   - enforces `meetings.export` capability (the right gate already)
 *   - returns 501 with `extractor_pending` so the UI can render a
 *     deterministic "Stream B not merged" state.
 *
 * Stream B replaces the body of this route; the capability gate +
 * URL shape stay stable.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";

interface Ctx {
  params: Promise<{
    slug: string;
    messageId: string;
    attachmentId: string;
  }>;
}

export async function GET(req: NextRequest, _ctx: Ctx) {
  const auth = await requireCapability(req, "meetings.export");
  if (!auth.ok) return auth.response;

  return NextResponse.json(
    {
      error: "extractor_pending",
      detail:
        "attachment download is owned by meeting-insights Stream B; not yet merged",
    },
    { status: 501 },
  );
}
