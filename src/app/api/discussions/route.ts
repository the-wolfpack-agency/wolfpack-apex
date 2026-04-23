import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getThreads, createThread, type DiscussionCategory } from "@/lib/discussions";
import { trackEvent } from "@/lib/analytics";
import { notify } from "@/lib/notifications/in-app";
import { safeQuery } from "@/lib/db";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const category = req.nextUrl.searchParams.get("category") || undefined;
  const status = req.nextUrl.searchParams.get("status") || undefined;

  const threads = await getThreads(
    category as DiscussionCategory | undefined,
    status as Parameters<typeof getThreads>[1],
  );

  trackEvent("system.page_viewed", user.id, user.role, { page: "discussions_list" });
  return NextResponse.json({ threads });
}

/**
 * POST /api/discussions — create a new thread.
 *
 * Body: { title, category, content, tags?, notify_all? }
 *
 * When `notify_all === true`, after the thread is persisted we fan out one
 * in-app notification per active row in `instinct_team_members`, using the
 * shared `notify()` helper (preferences + dedup + analytics are respected).
 * The fanout is best-effort: a failure on any individual recipient is logged
 * and skipped, and the POST still returns 201 with the new thread. The
 * `discussions.notify_all_fanout` analytics event records the recipient
 * count for the learning loop.
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { title, category, content, tags, notify_all } = body;

  if (!title || !category || !content) {
    return NextResponse.json({ error: "title, category, and content are required" }, { status: 400 });
  }

  const thread = await createThread(
    title,
    category as DiscussionCategory,
    user.id,
    content,
    tags,
  );

  if (thread && notify_all === true) {
    // Best-effort fanout. Failures swallowed so the create path can't be
    // broken by a flaky preferences read or a downstream timeout.
    try {
      const { rows } = await safeQuery<{ id: string }>(
        `SELECT id FROM instinct_team_members WHERE is_active = true`,
      );
      const actionUrl = `/discussions#${thread.id}`;
      const authorLabel = user.name || user.email || user.id;
      const bodyText =
        `${authorLabel} started a new discussion in ${thread.category}: ` +
        `${thread.title}`;

      let recipientCount = 0;
      for (const row of rows) {
        try {
          await notify({
            userId: row.id,
            category: "discussions",
            priority: "normal",
            title: `New discussion: ${thread.title}`,
            body: bodyText,
            actionUrl,
            actionLabel: "View discussion",
            source: "instinct.discussions",
            sourceId: thread.id,
            metadata: {
              discussion_id: thread.id,
              author_id: user.id,
              fanout: "notify_all",
            },
            dedup: true,
          });
          recipientCount += 1;
        } catch (err) {
          console.warn(
            "[discussions.notify_all] skip",
            row.id,
            (err as Error).message,
          );
        }
      }

      trackEvent("discussions.notify_all_fanout", user.id, user.role, {
        discussion_id: thread.id,
        recipient_count: recipientCount,
      });
    } catch (err) {
      console.warn(
        "[discussions.notify_all] fanout failed",
        (err as Error).message,
      );
    }
  }

  return NextResponse.json({ thread }, { status: 201 });
}
