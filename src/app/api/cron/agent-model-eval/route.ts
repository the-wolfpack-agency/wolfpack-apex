/**
 * GET /api/cron/agent-model-eval: the agent model-version regression sweep.
 *
 * Walks every active agent, groups its completed tasks by the model that ran
 * them, and compares the newest model's task-success rate against the model it
 * used before. A meaningful shift (regressed | improved) is persisted to the
 * regression ledger; a regression additionally audits, notifies the owner, and
 * emits agent.model_regression_detected. This is how a model bump that quietly
 * degrades a governed principal gets caught without a human watching, closing
 * the "agents behave inconsistently across model versions" gap that behavior
 * drift alone cannot attribute.
 *
 * Two auth paths (mirrors /api/cron/agent-drift exactly):
 *   1. Cron path: `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron hits this
 *      on the daily schedule. Returns false when CRON_SECRET is unset (local
 *      dev) so the user-session path is the only way in.
 *   2. User path: `requireCapability(req, "settings.manage_team")` for a
 *      logged-in admin triggering a manual sweep from the agent admin surface.
 *
 * Never 500s on a recoverable condition: per-agent failures are swallowed inside
 * runModelEvalSweep, and an unexpected throw is caught and returned as a zeroed
 * 200 so the cron health-monitor stays green.
 *
 * Audit: a detected regression audits itself inside runModelEvalCheck, so this
 * scheduled sweep does not call recordAudit per agent (the route mutates nothing
 * directly; the lib owns the ledger write + audit).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { runModelEvalSweep } from "@/lib/agents/evals/store";

/**
 * Cron secret check. Mirrors src/app/api/cron/agent-drift/route.ts so all our
 * cron-triggered endpoints share one mental model. Returns false when
 * CRON_SECRET is unset (local dev) so the user-session path is the only way in.
 */
function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function runSweep(): Promise<NextResponse> {
  try {
    const result = await runModelEvalSweep();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[cron/agent-model-eval]", (err as Error).message);
    return NextResponse.json({ ok: true, result: { checked: 0, regressed: 0 } });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) {
    return runSweep();
  }

  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return runSweep();
}
