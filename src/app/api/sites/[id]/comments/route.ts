/**
 * /api/sites/[id]/comments — authed Instinct user routes.
 *
 * Path C Phase 3 · Stream R3. Two verbs here:
 *
 *   GET  → List every comment (open + resolved) for the site, newest
 *          first. Role ≥ sales (same floor as SharePanel — any team
 *          member who can see the site can read the comments).
 *
 *   POST → Designer posts a comment OR a reply. `shareTokenId` is
 *          always null on this path (authed write). If `parentCommentId`
 *          is present the row is a reply; site.comment_replied fires.
 *
 * The per-comment lifecycle verbs (resolve, delete) live in the
 * nested `/[commentId]` segment so the verbs don't collide:
 *   POST /api/sites/[id]/comments/[commentId]/resolve
 *   DELETE /api/sites/[id]/comments/[commentId]
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";
import { getSiteProject } from "@/lib/sites";
import {
  listCommentsForSite,
  postComment,
  CommentValidationError,
  COMMENT_BODY_MAX,
} from "@/lib/section-comments";
import { trackEvent } from "@/lib/analytics";
import { WriteQueryError } from "@/lib/db";

async function authorize(req: NextRequest, siteId: string) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return {
      user: null as null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const site = await getSiteProject(siteId);
  if (!site) {
    return {
      user,
      response: NextResponse.json({ error: "not found" }, { status: 404 }),
    };
  }
  if (!hasRole(user.role, "sales")) {
    return {
      user,
      response: NextResponse.json(
        { error: "insufficient role", reason: "role_insufficient" },
        { status: 403 },
      ),
    };
  }
  return { user, response: null as null };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorize(req, id);
  if (response || !user) return response!;

  const url = req.nextUrl;
  const filter = url.searchParams.get("filter") ?? "all"; // open | resolved | all
  try {
    const all = await listCommentsForSite(id);
    const filtered =
      filter === "open"
        ? all.filter((c) => c.state === "open")
        : filter === "resolved"
          ? all.filter((c) => c.state === "resolved")
          : all;
    return NextResponse.json({ comments: filtered });
  } catch (err) {
    console.error("[sites/comments/GET]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const { user, response } = await authorize(req, id);
  if (response || !user) return response!;

  let body: {
    pageIndex?: unknown;
    sectionIndex?: unknown;
    sectionType?: unknown;
    body?: unknown;
    parentCommentId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", reason: "bad_body" },
      { status: 400 },
    );
  }

  if (!Number.isInteger(body.pageIndex) || (body.pageIndex as number) < 0) {
    return NextResponse.json(
      { error: "pageIndex required", reason: "bad_index" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(body.sectionIndex) || (body.sectionIndex as number) < 0) {
    return NextResponse.json(
      { error: "sectionIndex required", reason: "bad_index" },
      { status: 400 },
    );
  }
  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    return NextResponse.json(
      { error: "body required", reason: "body_empty" },
      { status: 400 },
    );
  }

  try {
    const record = await postComment({
      siteId: id,
      pageIndex: body.pageIndex as number,
      sectionIndex: body.sectionIndex as number,
      sectionType: typeof body.sectionType === "string" ? body.sectionType : undefined,
      body: body.body as string,
      actorName: user.name,
      actorEmail: user.email,
      parentCommentId:
        typeof body.parentCommentId === "string" ? body.parentCommentId : undefined,
    });

    const isReply = Boolean(body.parentCommentId);
    if (isReply) {
      trackEvent("site.comment_replied", user.id, user.role, {
        site_id: id,
        parent_comment_id: String(body.parentCommentId),
      });
    }
    trackEvent("site.comment_posted", user.id, user.role, {
      site_id: id,
      via_share_token: false,
      page_index: record.pageIndex,
      section_index: record.sectionIndex,
      section_type: record.sectionType ?? "",
      body_length: record.body.length,
      has_actor_email: record.actorEmail !== null,
    });

    return NextResponse.json({ comment: record });
  } catch (err) {
    if (err instanceof CommentValidationError) {
      return NextResponse.json(
        { error: err.message, reason: err.code, body_max: COMMENT_BODY_MAX },
        { status: 400 },
      );
    }
    if (err instanceof WriteQueryError) {
      return NextResponse.json(
        { error: "Failed to save comment", reason: err.code },
        { status: 503 },
      );
    }
    console.error("[sites/comments/POST]", (err as Error).message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
