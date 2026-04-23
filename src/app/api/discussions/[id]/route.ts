import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getThread,
  replyToThread,
  updateDiscussion,
  deleteDiscussion,
  type DiscussionCategory,
} from "@/lib/discussions";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { hasCapability } from "@/lib/auth/require-capability";

/**
 * GET /api/discussions/[id] — fetch a thread with its replies.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const thread = await getThread(id);

  if (!thread) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(thread);
}

/**
 * POST /api/discussions/[id] — post a reply to an existing thread.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { content, attachments } = body;

  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const reply = await replyToThread(id, user.id, content, attachments);
  return NextResponse.json({ reply }, { status: 201 });
}

/**
 * PUT /api/discussions/[id] — edit a thread (title / category / tags).
 *
 * Body: { title?: string, category?: DiscussionCategory, tags?: string[] }
 *
 * Auth: only the thread's creator (created_by) OR a user with
 * `discussions.resolve` may edit. `discussions.resolve` is the closest
 * "discussions moderator" capability; pin requires dev-role, resolve is
 * broader. Audit log + `discussions.discussion.edited` event fire on success.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const thread = await getThread(id);
    if (!thread) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const isOwner = thread.discussion.created_by === user.id;
    const canModerate = hasCapability(user, "discussions.resolve");
    if (!isOwner && !canModerate) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown;
      category?: unknown;
      tags?: unknown;
    };

    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : undefined;
    const category =
      typeof body.category === "string"
        ? (body.category as DiscussionCategory)
        : undefined;
    const tags = Array.isArray(body.tags)
      ? (body.tags.filter((t) => typeof t === "string") as string[])
      : undefined;

    if (title === undefined && category === undefined && tags === undefined) {
      return NextResponse.json(
        { error: "at least one of title, category, tags required" },
        { status: 400 },
      );
    }

    const updated = await updateDiscussion(id, user.id, user.role, {
      title,
      category,
      tags,
    });
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "discussions.discussion.edited",
      resourceType: "discussion",
      resourceId: id,
      beforeState: thread.discussion,
      afterState: updated,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({ ok: true, discussion: updated }, { status: 200 });
  } catch (err) {
    console.error("[discussions/id] PUT", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/discussions/[id] — delete a thread + its replies.
 *
 * Auth: same as PUT — owner OR `discussions.resolve`.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  try {
    const thread = await getThread(id);
    if (!thread) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const isOwner = thread.discussion.created_by === user.id;
    const canModerate = hasCapability(user, "discussions.resolve");
    if (!isOwner && !canModerate) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const ok = await deleteDiscussion(id, user.id, user.role);
    if (!ok) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "discussions.discussion.deleted",
      resourceType: "discussion",
      resourceId: id,
      beforeState: thread.discussion,
      afterState: null,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({ ok: true, id }, { status: 200 });
  } catch (err) {
    console.error("[discussions/id] DELETE", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
