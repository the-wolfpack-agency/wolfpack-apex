/**
 * GET /api/admin/insights/routing-coverage
 *
 * What share of ordinary sentences reach exactly one tool.
 *
 * WHY IT IS COMPUTED PER REQUEST RATHER THAN STORED. Intent matching is pure
 * functions over strings: no database, no model, no network. Computing it live
 * means the page can never show a number that was true at deploy time and has
 * since drifted, which is the failure mode of every cached quality metric.
 *
 * The corpus and the scoring live in src/lib/assistant/routing-audit.ts, the
 * same module `npm run assistant:routing` prints and routing-coverage.test.ts
 * ratchets. One definition, three readers. A score computed twice is a score
 * that eventually disagrees with itself, and the first person to notice would
 * be a client reading this page while the test is green.
 *
 * Gated on role rather than capability, matching the other insights routes,
 * because a second gating style on one page is how a page comes to have two
 * answers to who may read it.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { auditRouting } from "@/lib/assistant/routing-audit";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.role !== "ceo" && user.role !== "cto" && user.role !== "evp") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const r = await auditRouting();
    /* Clusters where EVERY prompt fails are a missing capability rather than a
       missing phrasing, which is a different kind of work and belongs in front
       of somebody who can decide to build it. The status cluster sat here for
       a day and became the pilot_status tool. */
    const deadClusters = Object.entries(r.byGroup)
      .filter(([, v]) => v.none === v.total)
      .map(([g]) => g);

    return NextResponse.json(
      {
        readable: true,
        total: r.total,
        reachedOne: r.reachedOne,
        reachedNone: r.reachedNone,
        reachedMany: r.reachedMany,
        /* Null rather than 0 for an empty corpus. A percentage of nothing is
           not zero percent, and this page has a rule about that. */
        percent: r.total > 0 ? Math.round((r.reachedOne / r.total) * 100) : null,
        deadClusters,
        unreachable: r.none,
        byGroup: r.byGroup,
      },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (err) {
    /* Unreadable is not the same fact as a bad score, and the panel renders
       the difference. A page that showed 0% because the registry failed to
       load would be reporting a catastrophe that had not happened. */
    return NextResponse.json(
      { readable: false, error: (err as Error).message },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
