/**
 * The gist layer's live state.
 *
 * Serves what the experiment measures, so the page shows the product's actual
 * behaviour rather than a screenshot of a good day. Read-only: it derives from
 * stored messages and writes nothing.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { extractGists } from "@/lib/gist/extract";
import { measureSignal, MIN_OBSERVATIONS } from "@/lib/gist/signal";
import { VOCABULARY } from "@/lib/gist/features";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  /* The same gate as the sibling insight routes. The gist holds nothing
     private by construction, but a failure profile is still a description of
     how we behave. */
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto" && user.role !== "evp") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const days = Math.min(Number(req.nextUrl.searchParams.get("days") ?? 90) || 90, 365);

  try {
    const gists = await extractGists(days);
    const report = measureSignal(gists);

    const outcomes: Record<string, number> = {};
    for (const g of gists) outcomes[g.outcome] = (outcomes[g.outcome] ?? 0) + 1;

    return NextResponse.json({
      readable: true,
      days,
      minObservations: MIN_OBSERVATIONS,
      turns: report.turns,
      baseBadRate: report.baseBadRate,
      outcomes,
      signals: report.signals,
      usable: report.usable,
      /* Sent so the page can show what a gist CAN contain. That list is the
         safety argument, and showing it is more convincing than describing
         it. */
      vocabulary: VOCABULARY,
    });
  } catch {
    /* readable:false rather than zeros: an unreadable store and a clean
       quarter must never render the same way. */
    return NextResponse.json({ readable: false, days });
  }
}
