/**
 * GET /api/onenote/pages?sectionId= — list pages from local cache.
 * POST /api/onenote/pages — create a new page (Graph write-through).
 *
 * Body for POST: { sectionId, title, html }
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  listCachedPages,
  createPage,
  OneNoteError,
  asScopeMissing,
} from "@/lib/integrations/microsoft-onenote";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const sectionId = url.searchParams.get("sectionId");
  const notebookId = url.searchParams.get("notebookId");
  const limitStr = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  const search = url.searchParams.get("search");

  const { pages, nextCursor } = await listCachedPages(user.id, {
    sectionId: sectionId || undefined,
    notebookId: notebookId || undefined,
    limit: limitStr ? parseInt(limitStr, 10) : undefined,
    cursor: cursor || undefined,
    search: search || undefined,
  });

  return NextResponse.json({ pages, nextCursor });
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { sectionId?: string; title?: string; html?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.sectionId || typeof body.sectionId !== "string") {
    return NextResponse.json({ error: "sectionId is required" }, { status: 400 });
  }
  if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (body.html !== undefined && typeof body.html !== "string") {
    return NextResponse.json({ error: "html must be a string" }, { status: 400 });
  }

  try {
    const created = await createPage(user.id, body.sectionId, {
      title: body.title.trim(),
      html: body.html ?? "",
    });
    return NextResponse.json({ page: created }, { status: 201 });
  } catch (err) {
    const scope = asScopeMissing(err, "Notes.ReadWrite");
    if (scope) return NextResponse.json(scope, { status: 403 });

    if (err instanceof OneNoteError) {
      trackEvent("system.ms_onenote_failed", user.id, user.role, {
        op: "create_page",
        http_status: err.status,
      });
      if (err.status === 401) {
        return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      }
      if (err.status === 429) {
        return NextResponse.json(
          { error: "Microsoft Graph rate limit" },
          {
            status: 429,
            headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : undefined,
          },
        );
      }
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
