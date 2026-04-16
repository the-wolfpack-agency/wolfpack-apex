/**
 * GET /api/presence/me — current user's presence.
 *
 * Real-time (no server cache). Client may cache for ~30s.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getOwnPresence } from "@/lib/integrations/microsoft-presence";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const presence = await getOwnPresence(user.id);
  return NextResponse.json(
    { presence },
    { headers: { "Cache-Control": "private, max-age=30" } },
  );
}
