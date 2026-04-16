/**
 * GET /api/onenote/notebooks — list caller's OneNote notebooks.
 *
 * Goes to Graph directly (notebooks rarely change; cache would drift).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  listNotebooks,
  OneNoteError,
  asScopeMissing,
} from "@/lib/integrations/microsoft-onenote";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const notebooks = await listNotebooks(user.id);
    return NextResponse.json({ notebooks });
  } catch (err) {
    const scope = asScopeMissing(err, "Notes.ReadWrite");
    if (scope) return NextResponse.json(scope, { status: 403 });

    if (err instanceof OneNoteError) {
      trackEvent("system.ms_onenote_failed", user.id, user.role, {
        op: "list_notebooks",
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
