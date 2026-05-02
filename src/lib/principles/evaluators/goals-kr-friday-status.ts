/**
 * Real evaluator for `goals.kr_friday_status`.
 *
 * Wolfpack principle 7 (Finish Strong) reaches into Goals: "weekly KRs
 * closed or marked at-risk by Friday". This evaluator checks whether
 * each active KR received ANY contribution row in the eval window —
 * `instinct_contributions` is the canonical update stream (manual KR
 * updates from the Friday sync flow + auto-linked ms_event / ms_task
 * contributions both land here).
 *
 * One observation per active KR. Score:
 *   updated in window → +0.4 (adherence — finish strong)
 *   not updated       → -0.4 (drift — KR went silent this week)
 *
 * Team-wide signal — KRs aren't per-member-scoped at the row level.
 * Each member's per-user view sees the same KR rollup, mirroring
 * `goals-kr-measurability.ts` / `code-cycle-time.ts`.
 */

import { safeQuery } from "@/lib/db";
import {
  snapToUtcDay,
  type EvaluationContext,
  type Observation,
} from "@/lib/principles/validators";

interface ActiveKr {
  kr_id: string;
  kr_metric: string;
  okr_id: string;
  okr_objective: string;
}

interface ContribCount {
  kr_id: string;
  contrib_count: string;
  last_at: string | null;
}

export async function evaluateGoalsKrFridayStatus(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  /* Team-wide signal: every active KR is org-wide data. evaluate-runner
     dispatches teamWide validators with no subject_user_id; we omit it
     from the row so the scoreboard renders these in the team lane
     instead of duplicating per member. */

  let krs: { rows: ActiveKr[] };
  try {
    krs = await safeQuery<ActiveKr>(
      `SELECT k.id AS kr_id, k.metric AS kr_metric,
              o.id AS okr_id, o.objective AS okr_objective
         FROM instinct_company_krs k
         JOIN instinct_company_okrs o ON o.id = k.okr_id
        WHERE o.status IN ('active','draft')`,
      [],
    );
  } catch {
    return [];
  }
  if (krs.rows.length === 0) return [];

  let contribs: { rows: ContribCount[] };
  try {
    contribs = await safeQuery<ContribCount>(
      `SELECT kr_id::text AS kr_id,
              COUNT(*)::text AS contrib_count,
              MAX(created_at)::text AS last_at
         FROM instinct_contributions
        WHERE created_at >= $1 AND created_at <= $2
        GROUP BY kr_id`,
      [ctx.windowStart, ctx.windowEnd],
    );
  } catch {
    return [];
  }
  const byKr = new Map<string, ContribCount>();
  for (const r of contribs.rows) byKr.set(r.kr_id, r);

  const observedAt = snapToUtcDay(ctx.windowEnd);
  return krs.rows.map((kr) => {
    const c = byKr.get(kr.kr_id);
    const count = c ? Number(c.contrib_count) : 0;
    const updated = count > 0;
    return {
      surface: "goals",
      surfaceSubtype: "kr_friday_status",
      observedAt,
      score: updated ? 0.4 : -0.4,
      evidence: {
        kind: "kr_friday_status",
        sourceId: kr.kr_id,
        notes: updated
          ? `${kr.kr_metric} — ${count} update${count === 1 ? "" : "s"} this window (last ${c!.last_at})`
          : `${kr.kr_metric} — no updates this window (OKR: ${kr.okr_objective.slice(0, 80)})`,
        metric: { name: "contrib_count", value: count },
      },
    };
  });
}
