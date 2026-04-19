/**
 * /api/people/insights — list HR insights for the Insights tab.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { safeQuery } from "@/lib/db";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const r = await safeQuery(
    `SELECT * FROM instinct_hr_insights WHERE status != 'dismissed' ORDER BY created_at DESC LIMIT 100`,
  );
  return NextResponse.json({ insights: r.rows });
}
