/**
 * GET /api/cron/principles-evaluate
 *
 * Per-team-member fan-out evaluator. For every signal with a bound
 * validator on every active principle, evaluates the signal once per
 * connected M365 user and writes Observations.
 *
 * Failure isolation lives inside `evaluatePrinciples` — one user's
 * broken token never blocks the rest of the run.
 *
 * Auth: Bearer CRON_SECRET, same as principles-sync.
 */

import { NextRequest, NextResponse } from "next/server";
import { listActivePrinciples } from "@/lib/principles/store";
import { evaluatePrinciples } from "@/lib/principles/evaluate-runner";

function requireCron(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

export async function GET(req: NextRequest) {
  if (!requireCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const u = new URL(req.url);
  const raw = u.searchParams.get("windowDays");
  const windowDays = Math.max(1, Math.min(30, raw ? Number(raw) || 7 : 7));

  const principles = await listActivePrinciples();
  const result = await evaluatePrinciples(principles, { windowDays });

  if (result.skippedReason === "no_bindings") {
    return NextResponse.json({
      ok: true,
      reason: "no_bindings",
      principleCount: principles.length,
    });
  }
  if (result.skippedReason === "no_connected_users") {
    return NextResponse.json({
      ok: true,
      reason: "no_connected_users",
      bindingCount: result.bindingCount,
    });
  }

  return NextResponse.json({
    ok: true,
    bindings: result.bindingCount,
    users: result.userCount,
    observations: result.observationCount,
    failures: result.failureCount,
    perValidator: result.perValidator,
  });
}
