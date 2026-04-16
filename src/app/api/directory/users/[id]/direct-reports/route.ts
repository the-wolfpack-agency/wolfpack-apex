/**
 * GET /api/directory/users/[id]/direct-reports
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getDirectReports } from "@/lib/integrations/microsoft-directory";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const reports = await getDirectReports(user.id, id);
  return NextResponse.json({ reports });
}
