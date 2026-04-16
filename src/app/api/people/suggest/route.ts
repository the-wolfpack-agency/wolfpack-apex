/**
 * GET /api/people/suggest?q=...&top=... — autocomplete-style people
 * suggestions powered by Graph `/me/people`.
 *
 * 60-second cache per (user, normalized query).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { suggestPeople, GraphPeopleError } from "@/lib/integrations/microsoft-people";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? undefined;
  const topStr = url.searchParams.get("top");
  let top = topStr ? parseInt(topStr, 10) : 10;
  if (Number.isNaN(top) || top < 1) top = 10;
  if (top > 50) top = 50;

  try {
    const suggestions = await suggestPeople(user.id, q, top);
    return NextResponse.json({ suggestions });
  } catch (err) {
    if (err instanceof GraphPeopleError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
