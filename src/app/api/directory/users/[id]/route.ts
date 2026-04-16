/**
 * GET /api/directory/users/[id]
 *
 * User detail by Graph id OR userPrincipalName. Cache-first; cache-miss
 * triggers a single Graph fetch + upsert.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getUser } from "@/lib/integrations/microsoft-directory";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const detail = await getUser(user.id, id);
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    { user: detail },
    { headers: { "Cache-Control": "private, max-age=60" } },
  );
}
