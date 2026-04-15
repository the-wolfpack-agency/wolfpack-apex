import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getJournalHistory, getTeamJournals } from "@/lib/journal";

/**
 * GET /api/journal/history — Get journal history.
 *
 * Query params:
 *   ?days=7     — number of days to look back
 *   ?team=true  — show all team journals for a date (journal.read_all)
 *   ?date=YYYY-MM-DD — specific date for team view
 */
export async function GET(req: NextRequest) {
  // Base requirement: everyone who can write their journal can read history.
  const auth = await requireCapability(req, "journal.write");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? 7);
  const team = url.searchParams.get("team");
  const date = url.searchParams.get("date") ?? undefined;

  try {
    if (team === "true") {
      // Team view: additional gate.
      if (!auth.capabilities.has("journal.read_all")) {
        return NextResponse.json(
          { error: "forbidden", capability: "journal.read_all" },
          { status: 403 },
        );
      }
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
