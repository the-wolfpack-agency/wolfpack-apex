/**
 * GET /api/onenote/pages/[id] — fetch a page's raw HTML content from Graph.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  getPageContent,
  OneNoteError,
  asScopeMissing,
} from "@/lib/integrations/microsoft-onenote";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  try {
    const html = await getPageContent(user.id, id);
    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    const scope = asScopeMissing(err, "Notes.ReadWrite");
    if (scope) return NextResponse.json(scope, { status: 403 });

    if (err instanceof OneNoteError) {
      trackEvent("system.ms_onenote_failed", user.id, user.role, {
        op: "get_page_content",
        http_status: err.status,
      });
      if (err.status === 401) {
        return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      }
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
