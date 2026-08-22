/**
 * GET /api/routines: everything about this person's chains in one read.
 *
 * WHY ONE ROUTE AND NOT FOUR
 *
 * The page answers one question, "how is this going for me", and it answers it
 * with four things that only make sense together: what you have saved, what
 * runs on its own, what has run lately, and what your own steps are costing
 * you. Four requests would render four boxes filling in at different moments,
 * which reads as four features rather than one answer.
 *
 * Read-only, and scoped to the caller. A routine is somebody's own morning: a
 * page listing a colleague's would be a page about how they spend their day.
 *
 * routines.view is a SELF_SERVICE capability, held by every seat. Every
 * routine here is one the caller owns, so there is nothing to withhold from
 * the person it describes, and gating a page about somebody's own day behind
 * an admin capability would mean the people the feature exists for could not
 * see it.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listSavedRoutines } from "@/lib/assistant/routines/saved";
import { listRecentRuns } from "@/lib/assistant/routines/store";
import { listSchedules } from "@/lib/assistant/routines/schedule-store";
import { describeSchedule } from "@/lib/assistant/routines/schedule";
import { humanStepFindings } from "@/lib/assistant/routines/human-insight";
import { BUILT_IN_ROUTINES } from "@/lib/assistant/routines/catalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "routines.view");
  if (!auth.ok) return auth.response;

  const owner = {
    workspaceId: auth.user.workspaceId ?? "default",
    userId: auth.user.id,
  };

  /* In parallel: they are independent reads and the page needs all four before
     it can say anything useful. */
  const [saved, runs, schedules, findings] = await Promise.all([
    listSavedRoutines(owner),
    listRecentRuns(owner),
    listSchedules(owner),
    humanStepFindings(owner.workspaceId),
  ]);

  return NextResponse.json(
    {
      ok: true,
      /* Built-ins are included so the page is never empty for somebody who has
         not saved anything yet. An empty page on first visit teaches people
         there is nothing here. */
      builtIn: BUILT_IN_ROUTINES.map((r) => ({
        command: r.command,
        description: r.description,
        steps: r.steps.length,
        humanSteps: r.steps.filter((s) => s.kind === "human").length,
      })),
      saved: saved.map((r) => ({
        command: r.command,
        description: r.description,
        steps: r.steps.length,
        humanSteps: r.steps.filter((s) => s.kind === "human").length,
      })),
      schedules: schedules.map((s) => ({
        command: s.command,
        when: describeSchedule(s.schedule),
        nextRunAt: s.nextRunAt.toISOString(),
      })),
      runs,
      findings,
    },
    { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
