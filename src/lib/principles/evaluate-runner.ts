/**
 * evaluate-runner — shared orchestration for "evaluate principle X
 * across the org RIGHT NOW", reused by:
 *
 *   - the periodic cron (`/api/cron/principles-evaluate`) which loops
 *     all active principles
 *   - on-create / on-edit hooks in the native CRUD endpoints — so a
 *     freshly-saved principle starts populating the scoreboard the
 *     moment leadership clicks Save (no 4h cron wait)
 *   - the manual "Run now" button on the manager UI
 *
 * Failure isolation: each (validator × user) call is wrapped in
 * try/catch + analytics emission — one user's broken token can never
 * halt the rest of the run.
 *
 * Zero LLM tokens per the global zero-tokens-first invariant.
 */

import { trackEvent } from "@/lib/analytics";
import {
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

export interface EvaluateOptions {
  /** Default eval window in days. Overridable per-validator below
   *  when bootstrapping (no prior observations → widen to 30d). */
  windowDays?: number;
  /** Force the wide bootstrap window for every binding even if
   *  observations already exist. Used by the manual "Run now" path so
   *  leadership immediately sees a baseline after creating a principle. */
  forceBootstrap?: boolean;
  /** Optional iterator override — tests inject this to avoid hitting
   *  the real M365 token table. */
  listUsers?: typeof listConnectedM365Users;
}

export interface EvaluateResult {
  bindingCount: number;
  userCount: number;
  observationCount: number;
  failureCount: number;
  perValidator: Record<string, number>;
  /** Reason populated when no work was done — useful for the UI to
   *  show "no signals matched" / "no users connected" instead of a
   *  silent zero. */
  skippedReason?: "no_bindings" | "no_connected_users";
}

interface Binding {
  principle: PrincipleRecord;
  signal: PrincipleSignalRecord;
  validator: Validator;
}

async function bindingsForPrinciple(
  p: PrincipleRecord,
): Promise<Binding[]> {
  const out: Binding[] = [];
  const signals = await listSignalsForPrinciple(p.id);
  for (const s of signals) {
    const v = findValidatorForDescription(s.description);
    if (!v) continue;
    out.push({ principle: p, signal: s, validator: v });
  }
  return out;
}

function defaultWindow(windowDays: number) {
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
  };
}

/** Evaluate all bindings on `principles` against every connected M365
 *  user. Used by both the cron (passing every active principle) and
 *  the on-create/edit/manual hooks (passing a single principle). */
export async function evaluatePrinciples(
  principles: readonly PrincipleRecord[],
  opts: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const windowDays = Math.max(1, Math.min(30, opts.windowDays ?? 7));
  const window = defaultWindow(windowDays);

  const bindings: Binding[] = [];
  for (const p of principles) {
    bindings.push(...(await bindingsForPrinciple(p)));
  }

  if (bindings.length === 0) {
    trackEvent("principle.evaluation_skipped", "system", "system", {
      reason: "no_bindings",
      principle_count: principles.length,
    });
    return {
      bindingCount: 0,
      userCount: 0,
      observationCount: 0,
      failureCount: 0,
      perValidator: {},
      skippedReason: "no_bindings",
    };
  }

  const listUsers = opts.listUsers ?? listConnectedM365Users;
  const users = await listUsers();
  if (users.length === 0) {
    trackEvent("principle.evaluation_skipped", "system", "system", {
      reason: "no_connected_users",
      binding_count: bindings.length,
    });
    return {
      bindingCount: bindings.length,
      userCount: 0,
      observationCount: 0,
      failureCount: 0,
      perValidator: {},
      skippedReason: "no_connected_users",
    };
  }

  let observationCount = 0;
  let failureCount = 0;
  const perValidator: Record<string, number> = {};

  for (const b of bindings) {
    /* Bootstrap: widen to 30d for first-time validators OR when the
       caller asks for it (manual "Run now" / freshly-created
       principle). */
    let perValidatorWindow = window;
    if (opts.forceBootstrap) {
      perValidatorWindow = defaultWindow(30);
    } else {
      try {
        const seen = await hasAnyObservationForValidator(b.validator.id);
        if (!seen) perValidatorWindow = defaultWindow(30);
      } catch {
        /* fall through to default window */
      }
    }

    const rows: Parameters<typeof insertObservations>[0]["rows"] = [];

    if (b.validator.teamWide) {
      /* Team-wide validators (goals.kr_*, code.pr_cycle_time_under)
         read org-wide data — every active KR, every team PR. Running
         them per-user duplicates the same evidence under each member,
         inflating counts and flattening the per-member mean. Run once;
         every row lands with subject_user_id=null and surfaces as a
         "team" lane on the scoreboard. */
      const ctx: EvaluationContext = {
        windowStart: perValidatorWindow.windowStart,
        windowEnd: perValidatorWindow.windowEnd,
      };
      try {
        const observations = await b.validator.evaluate(ctx);
        for (const o of observations) {
          rows.push({
            surface: o.surface,
            surfaceSubtype: o.surfaceSubtype ?? null,
            subjectUserId: null,
            observedAt: o.observedAt,
            score: o.score,
            evidenceJsonb: o.evidence as unknown as Record<string, unknown>,
          });
        }
      } catch (err) {
        failureCount++;
        trackEvent("principle.evaluation_failed", "system", "system", {
          validator_id: b.validator.id,
          principle_slug: b.principle.slug,
          team_wide: true,
          error: (err as Error).message,
        });
      }
    } else {
      for (const u of users) {
        const ctx: EvaluationContext = {
          windowStart: perValidatorWindow.windowStart,
          windowEnd: perValidatorWindow.windowEnd,
          subjectUserId: u.userId,
        };
        try {
          const observations = await b.validator.evaluate(ctx);
          for (const o of observations) {
            rows.push({
              surface: o.surface,
              surfaceSubtype: o.surfaceSubtype ?? null,
              subjectUserId: o.subjectUserId ?? u.userId,
              observedAt: o.observedAt,
              score: o.score,
              evidenceJsonb: o.evidence as unknown as Record<string, unknown>,
            });
          }
        } catch (err) {
          failureCount++;
          trackEvent("principle.evaluation_failed", u.userId, "system", {
            validator_id: b.validator.id,
            principle_slug: b.principle.slug,
            error: (err as Error).message,
          });
        }
      }
    }

    if (rows.length > 0) {
      try {
        const inserted = await insertObservations({
          principleId: b.principle.id,
          signalId: b.signal.id,
          validatorId: b.validator.id,
          rows,
        });
        observationCount += inserted;
        perValidator[b.validator.id] =
          (perValidator[b.validator.id] ?? 0) + inserted;
      } catch (err) {
        failureCount++;
        trackEvent("principle.evaluation_failed", "system", "system", {
          stage: "insert",
          validator_id: b.validator.id,
          error: (err as Error).message,
        });
      }
    }
  }

  trackEvent("principle.observations_recorded", "system", "system", {
    binding_count: bindings.length,
    user_count: users.length,
    observation_count: observationCount,
    failure_count: failureCount,
  });

  return {
    bindingCount: bindings.length,
    userCount: users.length,
    observationCount,
    failureCount,
    perValidator,
  };
}
