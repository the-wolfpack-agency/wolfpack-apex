/**
 * /api/discussions/[id]/comments/[commentId] — edit/delete an individual
 * reply (a.k.a. comment) on a discussion thread.
 *
 * Auth: only the reply's author (reply.author_id === user.id) OR a user
 * with `discussions.resolve` may edit/delete. Consistent with the
 * thread-level PUT/DELETE handler in ../../route.ts.
 *
 * Every mutation writes to the audit log and fires a
 * `discussions.comment.*` analytics event.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getReply, updateReply, deleteReply } from "@/lib/discussions";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { hasCapability } from "@/lib/auth/require-capability";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: discussionId, commentId } = await params;

  try {
    const reply = await getReply(commentId);
    if (!reply || reply.discussion_id !== discussionId) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const isAuthor = reply.author_id === user.id;
    const canModerate = hasCapability(user, "discussions.resolve");
    if (!isAuthor && !canModerate) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as { content?: unknown };
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      return NextResponse.json(
        { error: "content is required" },
        { status: 400 },
      );
    }

    const updated = await updateReply(
      commentId,
      user.id,
      user.role,
      body.content,
    );
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "discussions.comment.edited",
      resourceType: "discussion_reply",
      resourceId: commentId,
      beforeState: reply,
      afterState: updated,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({ ok: true, reply: updated }, { status: 200 });
  } catch (err) {
    console.error("[discussions/id/comments/commentId] PUT", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: discussionId, commentId } = await params;

  try {
    const reply = await getReply(commentId);
    if (!reply || reply.discussion_id !== discussionId) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const isAuthor = reply.author_id === user.id;
    const canModerate = hasCapability(user, "discussions.resolve");
    if (!isAuthor && !canModerate) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const ok = await deleteReply(commentId, user.id, user.role);
    if (!ok) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "discussions.comment.deleted",
      resourceType: "discussion_reply",
      resourceId: commentId,
      beforeState: reply,
      afterState: null,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({ ok: true, id: commentId }, { status: 200 });
  } catch (err) {
    console.error("[discussions/id/comments/commentId] DELETE", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
