import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { markAllRead } from "@/lib/notifications/in-app";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const count = await markAllRead(user.id);
  return NextResponse.json({ ok: true, count });
}
