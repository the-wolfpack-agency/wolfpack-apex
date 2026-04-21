/**
 * goals_lookup tool — reads active OKRs + KRs + latest North Star.
 * Zero tokens; pure read over the goals lib.
 */

import { getActiveOKRs } from "@/lib/goals";
import { getNorthStarTrend } from "@/lib/goals-north-star";

export interface GoalsLookupResult {
  northStar: { label: string; value: number; unit: string | null } | null;
  okrs: Array<{
    id: string;
    quarter: string;
    objective: string;
    krs: Array<{
      metric: string;
      current_value: number;
      target_value: number;
      unit: string | null;
    }>;
  }>;
  answer: string;
  source: "goals";
}

export async function runGoalsLookup(): Promise<GoalsLookupResult | null> {
  let okrs: Awaited<ReturnType<typeof getActiveOKRs>> = [];
  let trend: Awaited<ReturnType<typeof getNorthStarTrend>> = { latest: null, history: [] };
  try {
    [okrs, trend] = await Promise.all([getActiveOKRs(), getNorthStarTrend({ limit: 1 })]);
  } catch {
    return null;
  }

  if (okrs.length === 0 && !trend.latest) return null;

  const northStar = trend.latest
    ? { label: trend.latest.label, value: trend.latest.value, unit: trend.latest.unit }
    : null;

  const flatOkrs = okrs.map((o) => ({
    id: o.id,
    quarter: o.quarter,
    objective: o.objective,
    krs: (o.krs ?? []).map((k) => ({
      metric: k.metric,
      current_value: k.current_value,
      target_value: k.target_value,
      unit: k.unit,
    })),
  }));

  const nsLine = northStar
    ? `North Star: ${northStar.label} = ${northStar.value}${northStar.unit ? ` ${northStar.unit}` : ""}.`
    : "North Star: not yet set.";
  const okrLines = flatOkrs
    .slice(0, 5)
    .map(
      (o) =>
        `${o.quarter} · ${o.objective} (${o.krs.length} KR${o.krs.length === 1 ? "" : "s"})`,
    )
    .join("\n");
  const answer = `${nsLine}\n\nActive OKRs (${flatOkrs.length}):\n${okrLines || "none"}`;

  return { northStar, okrs: flatOkrs, answer, source: "goals" };
}
