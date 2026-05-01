/**
 * GET /api/cron/principles-evaluate
 *
 * Per-team-member fan-out evaluator. For every signal with a bound
 * validator on every active principle, evaluates the signal once per
 * connected M365 user and writes Observations.
 *
 * Failure isolation: each (validator × user) call is wrapped in
 * try/catch with an analytics emission on failure. One user's broken
 * token never blocks the rest of the run.
 *
 * Auth: Bearer CRON_SECRET, same as principles-sync.
 */

import { NextRequest, NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";
import {
  listActivePrinciples,
  listSignalsForPrinciple,
  insertObservations,
  hasAnyObservationForValidator,
  type PrincipleRecord,
  type PrincipleSignalRecord,
} from "@/lib/principles/store";
import { listConnectedM365Users } from "@/lib/principles/users-iterator";
import {
  findValidatorForDescription,
  type Validator,
  type EvaluationContext,
} from "@/lib/principles/validators";
/* Side-effect: registers the 5 starter validators (incl. the real
   mail.after_hours_send) into the global registry. */
import "@/lib/principles/built-in-validators";

function requireCron(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

/** Build an evaluation window: last 7 days by default, configurable
 *  via ?windowDays=N (cap 30). */
function buildWindow(req: NextRequest): {
  windowStart: string;
  windowEnd: string;
} {
  const u = new URL(req.url);
  const raw = u.searchParams.get("windowDays");
  const days = Math.max(1, Math.min(30, raw ? Number(raw) || 7 : 7));
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}

/** Resolve every signal on every active principle to its validator
 *  (when one matches by description). Skips signals that don't bind. */
async function resolveValidatorBindings(
  principles: readonly PrincipleRecord[],
): Promise<
  Array<{
    principle: PrincipleRecord;
    signal: PrincipleSignalRecord;
    validator: Validator;
  }>
> {
  const out: Array<{
    principle: PrincipleRecord;
    signal: PrincipleSignalRecord;
    validator: Validator;
  }> = [];
  for (const p of principles) {
    const signals = await listSignalsForPrinciple(p.id);
    for (const s of signals) {
      const v = findValidatorForDescription(s.description);
      if (!v) continue;
      out.push({ principle: p, signal: s, validator: v });
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!requireCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const window = buildWindow(req);

  /* Step 1 — load principles + bindings. */
  const principles = await listActivePrinciples();
  const bindings = await resolveValidatorBindings(principles);
  if (bindings.length === 0) {
    trackEvent("principle.evaluation_skipped", "system", "system", {
      reason: "no_bindings",
      principle_count: principles.length,
    });
    return NextResponse.json({
      ok: true,
      reason: "no_bindings",
      principleCount: principles.length,
    });
  }

  /* Step 2 — fan out across every connected M365 user. */
  const users = await listConnectedM365Users();
  if (users.length === 0) {
    trackEvent("principle.evaluation_skipped", "system", "system", {
      reason: "no_connected_users",
      binding_count: bindings.length,
    });
    return NextResponse.json({
      ok: true,
      reason: "no_connected_users",
      bindingCount: bindings.length,
    });
  }

  let totalObservations = 0;
  let totalFailures = 0;
  const perValidatorCounts: Record<string, number> = {};

  for (const b of bindings) {
    /* Bootstrap detection: on the very first run for a validator, the
       DB has zero observations against it. Widen the window to 30 days
       so leadership gets an immediate month-to-date baseline instead
       of a blank scoreboard. Subsequent runs use the normal 7-day
       (or query-overridden) window. */
    let perValidatorWindow = window;
    try {
      const seen = await hasAnyObservationForValidator(b.validator.id);
      if (!seen) {
        const days = 30;
        const end = new Date();
        const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
        perValidatorWindow = {
          windowStart: start.toISOString(),
          windowEnd: end.toISOString(),
        };
      }
    } catch {
      /* fall through to default window */
    }

    const rowsForBinding: Parameters<typeof insertObservations>[0]["rows"] = [];
    for (const u of users) {
      const ctx: EvaluationContext = {
        windowStart: perValidatorWindow.windowStart,
        windowEnd: perValidatorWindow.windowEnd,
        subjectUserId: u.userId,
      };
      try {
        const observations = await b.validator.evaluate(ctx);
        for (const o of observations) {
          rowsForBinding.push({
            surface: o.surface,
            surfaceSubtype: o.surfaceSubtype ?? null,
            subjectUserId: o.subjectUserId ?? u.userId,
            observedAt: o.observedAt,
            score: o.score,
            evidenceJsonb: o.evidence as unknown as Record<string, unknown>,
          });
        }
      } catch (err) {
        totalFailures++;
        trackEvent(
          "principle.evaluation_failed",
          u.userId,
          "system",
          {
            validator_id: b.validator.id,
            principle_slug: b.principle.slug,
            error: (err as Error).message,
          },
        );
      }
    }
    if (rowsForBinding.length > 0) {
      try {
        const inserted = await insertObservations({
          principleId: b.principle.id,
          signalId: b.signal.id,
          validatorId: b.validator.id,
          rows: rowsForBinding,
        });
        totalObservations += inserted;
        perValidatorCounts[b.validator.id] =
          (perValidatorCounts[b.validator.id] ?? 0) + inserted;
      } catch (err) {
        totalFailures++;
        trackEvent(
          "principle.evaluation_failed",
          "system",
          "system",
          {
            stage: "insert",
            validator_id: b.validator.id,
            error: (err as Error).message,
          },
        );
      }
    }
  }

  trackEvent("principle.observations_recorded", "system", "system", {
    binding_count: bindings.length,
    user_count: users.length,
    observation_count: totalObservations,
    failure_count: totalFailures,
  });

  return NextResponse.json({
    ok: true,
    bindings: bindings.length,
    users: users.length,
    observations: totalObservations,
    failures: totalFailures,
    perValidator: perValidatorCounts,
  });
}
