/**
 * POST /api/notifications/test — dev-only. Creates a sample notification
 * for the caller so the bell + inbox can be exercised in QA.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { notify } from "@/lib/notifications/in-app";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await notify({
    userId: user.id,
    category: String(body.category ?? "system.test"),
    priority: (body.priority as "low" | "normal" | "high" | "critical" | undefined) ?? "normal",
    title: String(body.title ?? "Test notification"),
    body: body.body == null ? "This is a test" : String(body.body),
    actionUrl: body.actionUrl ? String(body.actionUrl) : "/notifications",
    actionLabel: body.actionLabel ? String(body.actionLabel) : "Open",
    source: "test",
    sourceId: body.sourceId ? String(body.sourceId) : undefined,
    metadata: { requested_by: user.id },
  });

  return NextResponse.json({ ok: true, result });
}
