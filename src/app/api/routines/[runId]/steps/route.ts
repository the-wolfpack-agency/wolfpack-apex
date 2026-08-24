/**
 * GET /api/routines/:runId/steps
 *
 * The steps of one run, in the order they happened, so a person can see
 * what the chain actually did rather than read a paragraph about it.
 *
 * Scoped by workspace and user inside the query rather than here: a run
 * id is guessable enough that reading somebody else's chain should not
 * come down to whether they picked a long one, and the step rows carry
 * another company's labels.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { stepsForRun } from "@/lib/assistant/routines/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ runId: string }> },
) {
  /* The same gate the routines page itself passes through. A second,
     looser check here would be a way to read chains the list will not
     show you. */
  const auth = await requireCapability(req, "routines.view");
  if (!auth.ok) return auth.response;

  const { runId } = await ctx.params;
  if (!runId) return NextResponse.json({ error: "runId is required" }, { status: 400 });

  const steps = await stepsForRun(
    { workspaceId: auth.user.workspaceId ?? "default", userId: auth.user.id },
    runId,
  );

  /* An empty list is a 200, not a 404. The run may be another user's, or
     it may genuinely have no steps yet, and the two are indistinguishable
     from here on purpose: telling somebody a run exists but is not theirs
     is itself an answer about somebody else's data. */
  return NextResponse.json(
    { runId, steps },
    { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
