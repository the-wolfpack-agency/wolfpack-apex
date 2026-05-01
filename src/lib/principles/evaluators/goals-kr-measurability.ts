/**
 * Real evaluator for `goals.kr_measurability`.
 *
 * Queries the `instinct_company_okrs` + `instinct_company_krs` tables
 * directly (instinct_goals system) and emits one Observation per
 * active OKR. Score is +0.5 (adherence) when the OKR has at least
 * one KR with a numeric target_value, -0.5 (drift) otherwise.
 *
 * This is a TEAM-WIDE signal — OKRs aren't per-member-scoped — so we
 * emit observations with `subjectUserId = ctx.subjectUserId` to keep
 * the per-member trickle uniform with other validators. (Same OKR
 * shows up in every member's per-user view.) This is intentional:
 * leadership is jointly accountable for measurable goals.
 */

import { safeQuery } from "@/lib/db";
import type {
  EvaluationContext,
  Observation,
} from "@/lib/principles/validators";

interface OkrRow {
  id: string;
  title: string;
  status: string;
}

interface KrRow {
  okr_id: string;
  target_value: string | null;
}

export async function evaluateGoalsKrMeasurability(
  ctx: EvaluationContext,
): Promise<Observation[]> {
  const userId = ctx.subjectUserId;
  if (!userId) return [];
  let okrs: { rows: OkrRow[] };
  try {
    okrs = await safeQuery<OkrRow>(
      `SELECT id, title, status
         FROM instinct_company_okrs
        WHERE status IN ('active','in_progress','draft')`,
      [],
    );
  } catch {
    return [];
  }
  if (okrs.rows.length === 0) return [];
  const krRes = await safeQuery<KrRow>(
    `SELECT okr_id, target_value FROM instinct_company_krs`,
    [],
  );
  const krsByOkr = new Map<string, KrRow[]>();
  for (const k of krRes.rows) {
    const list = krsByOkr.get(k.okr_id) ?? [];
    list.push(k);
    krsByOkr.set(k.okr_id, list);
  }

  const observedAt = new Date().toISOString();
  return okrs.rows.map((okr) => {
    const krs = krsByOkr.get(okr.id) ?? [];
    const hasMeasurable = krs.some((k) => {
      const v = k.target_value;
      if (v === null || v === undefined) return false;
      const n = Number(v);
      return Number.isFinite(n);
    });
    return {
      surface: "goals",
      surfaceSubtype: "okr_measurable",
      subjectUserId: userId,
      observedAt,
      score: hasMeasurable ? 0.5 : -0.5,
      evidence: {
        kind: "okr_measurable",
        sourceId: okr.id,
        notes: okr.title?.slice(0, 200),
        metric: { name: "kr_count", value: krs.length },
      },
    };
  });
}
