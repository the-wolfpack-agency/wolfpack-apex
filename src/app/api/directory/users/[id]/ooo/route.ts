/**
 * GET /api/directory/users/[id]/ooo — cache-only OOO state.
 *
 * For OTHERS we never hit Graph (MailboxSettings.Read is delegated to self
 * only). This endpoint reads whatever the owner's last refresh wrote.
 *
 * `id` is an internal Instinct user_id. There is intentionally no Graph
 * fallback path.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getCachedOOOState } from "@/lib/integrations/microsoft-mailbox";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const state = await getCachedOOOState(id);
  return NextResponse.json(
    { ooo: state },
    { headers: { "Cache-Control": "private, max-age=60" } },
  );
}
