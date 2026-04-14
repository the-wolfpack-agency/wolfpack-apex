import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getThreads, createThread, type DiscussionCategory } from "@/lib/discussions";
import { trackEvent } from "@/lib/analytics";

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

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { title, category, content, tags } = body;

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

  return NextResponse.json({ thread }, { status: 201 });
}
