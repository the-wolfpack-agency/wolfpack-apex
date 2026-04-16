/**
 * GET /api/directory/users/[id]/manager — resolve a user's manager.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getManager } from "@/lib/integrations/microsoft-directory";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const manager = await getManager(user.id, id);
  if (!manager) return NextResponse.json({ manager: null }, { status: 200 });
  return NextResponse.json({ manager });
}
