/**
 * Survey insights — pure funnel + completion math. No I/O. Fed counts
 * + responses by the insights route; returns the metrics a form SaaS
 * doesn't surface (completion rate, time-to-complete, channel + device
 * breakdown) alongside the per-question aggregate. Pure so it's fully
 * unit-testable.
 */

import { aggregateResponses } from "./validate";
import type { SurveyResponse, SurveySchema } from "./types";

export interface SurveyInsights {
  views: number;
  responses: number;
  /** responses / views, 0..1, rounded to 4dp (0 when no views). */
  completionRate: number;
  /** Mean time-on-form in ms over responses that reported a duration. */
  avgDurationMs: number | null;
  firstResponseAt: string | null;
  lastResponseAt: string | null;
  /** Response counts by device + country + referrer (attribution). */
  byDevice: Record<string, number>;
  byCountry: Record<string, number>;
  byReferrer: Record<string, number>;
  /** Per-question aggregate (option counts, rating averages, Other themes). */
  perQuestion: ReturnType<typeof aggregateResponses>;
}

function tally(values: Array<string | null>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = v && v.trim() ? v : "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export function computeInsights(
  schema: SurveySchema,
  views: number,
  responses: SurveyResponse[],
): SurveyInsights {
  const n = responses.length;
  const safeViews = Math.max(0, views);
  const durations = responses
    .map((r) => r.durationMs)
    .filter((d): d is number => typeof d === "number" && d >= 0);
  const avgDurationMs = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  const times = responses.map((r) => r.submittedAt).filter(Boolean).sort();

  return {
    views: safeViews,
    responses: n,
    // A response without a logged view (e.g. legacy / direct POST) can make
    // raw responses exceed views; cap the rate at 1 so it stays meaningful.
    completionRate: safeViews > 0 ? Math.min(1, Math.round((n / safeViews) * 10000) / 10000) : 0,
    avgDurationMs,
    firstResponseAt: times[0] ?? null,
    lastResponseAt: times[times.length - 1] ?? null,
    byDevice: tally(responses.map((r) => r.device)),
    byCountry: tally(responses.map((r) => r.country)),
    byReferrer: tally(responses.map((r) => r.referrer)),
    perQuestion: aggregateResponses(schema, responses.map((r) => r.answers)),
  };
}
