import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getJournalHistory, getTeamJournals } from "@/lib/journal";

/**
 * GET /api/journal/history — Get journal history.
 *
 * Query params:
 *   ?days=7     — number of days to look back
 *   ?team=true  — show all team journals for a date (CTO only)
 *   ?date=YYYY-MM-DD — specific date for team view
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? 7);
  const team = url.searchParams.get("team");
  const date = url.searchParams.get("date") ?? undefined;

  try {
    if (team === "true") {
      const journals = await getTeamJournals(date);
      return NextResponse.json({ journals, view: "team" });
    }

    const journals = await getJournalHistory(user.id, days);
    return NextResponse.json({ journals, view: "personal" });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
