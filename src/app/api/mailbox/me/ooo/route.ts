/**
 * GET /api/mailbox/me/ooo — current cached OOO state for the caller.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getCachedOOOState } from "@/lib/integrations/microsoft-mailbox";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const state = await getCachedOOOState(user.id);
  return NextResponse.json(
    { ooo: state },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}
