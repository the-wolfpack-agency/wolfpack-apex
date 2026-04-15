/**
 * POST /api/admin/notifications/trigger-digest?window=daily|weekly
 *
 * Admin-only manual trigger for the digest path. Useful for
 *   - bootstrapping new installs before the scheduler is wired
 *   - QA'ing digest output end-to-end
 *
 * Gated on role ceo|cto.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { sendDigests, type DigestWindow } from "@/lib/notifications/digest";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const windowRaw = url.searchParams.get("window") ?? "daily";
  if (windowRaw !== "daily" && windowRaw !== "weekly") {
    return NextResponse.json({ error: "invalid_window" }, { status: 400 });
  }
  const window: DigestWindow = windowRaw;

  // Force=true so admins can trigger regardless of local-time window.
  const result = await sendDigests({ window, force: true });
  return NextResponse.json({ ok: true, ...result });
}
