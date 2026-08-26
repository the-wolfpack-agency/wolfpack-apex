/**
 * Reading the answer-quality trend out of the event log.
 *
 * SERVER ONLY: this imports the database driver. The shape and the arithmetic
 * live in ./answer-quality so a client component can render the numbers
 * without dragging pg into the bundle.
 *
 * A CATCH COUNT WITHOUT ITS DENOMINATOR IS UNREADABLE, which is why every
 * signal is selected next to the volume it was measured against. See
 * ./answer-quality for what each one means and why they are not collapsed
 * into a single score.
 */
import { query } from "@/lib/db";
import type { QualityWeek, QualityTrend } from "./answer-quality";

export type { QualityWeek, QualityTrend } from "./answer-quality";
export { flaggedPerThousand, correctionRate } from "./answer-quality";

/** Older to newer, so a reader sees the direction rather than infers it. */
export async function getAnswerQualityTrend(weeks = 8): Promise<QualityTrend> {
  const bounded = Math.max(1, Math.min(52, Math.floor(weeks)));
  try {
    return await readTrend(bounded);
  } catch (err) {
    console.warn("[answer-quality-trend]", (err as Error).message);
    return { weeks: [], empty: true, readable: false };
  }
}

async function readTrend(bounded: number): Promise<QualityTrend> {
  const { rows } = await query<{
    week_start: string;
    model_calls: string;
    flagged: string;
    reviewed: string;
    corrected: string;
    irrelevant_retrievals: string;
    not_promoted: string;
  }>(
    `SELECT
       to_char(date_trunc('week', timestamp), 'YYYY-MM-DD') AS week_start,
       count(*) FILTER (WHERE event_type = 'ai.completion')::text AS model_calls,
       count(*) FILTER (WHERE event_type = 'ai.response_flagged')::text AS flagged,
       /* Reviewed at all, kept separate from changed. The router writes both
          on the same event precisely so "checked and fine" cannot be read as
          "not checked". Collapsing them here would undo that. */
       count(*) FILTER (
         WHERE event_type = 'ai.answer_improved'
           AND metadata->>'reviewed' = 'true'
       )::text AS reviewed,
       count(*) FILTER (
         WHERE event_type = 'ai.answer_improved'
           AND metadata->>'changed' = 'true'
       )::text AS corrected,
       count(*) FILTER (WHERE event_type = 'brain.retrieval_judged_irrelevant')::text
         AS irrelevant_retrievals,
       count(*) FILTER (WHERE event_type = 'assistant.answer_not_promoted')::text
         AS not_promoted
     FROM instinct_events
     WHERE timestamp >= date_trunc('week', NOW()) - ($1::int - 1) * INTERVAL '1 week'
       AND event_type IN (
         'ai.completion',
         'ai.response_flagged',
         'ai.answer_improved',
         'brain.retrieval_judged_irrelevant',
         'assistant.answer_not_promoted'
       )
     GROUP BY 1
     ORDER BY 1 ASC`,
    [bounded],
  );

  const weeksOut: QualityWeek[] = rows.map((r) => ({
    weekStart: r.week_start,
    modelCalls: Number(r.model_calls),
    flagged: Number(r.flagged),
    reviewed: Number(r.reviewed),
    corrected: Number(r.corrected),
    irrelevantRetrievals: Number(r.irrelevant_retrievals),
    notPromoted: Number(r.not_promoted),
  }));

  return {
    readable: true,
    weeks: weeksOut,
    /* Empty is about the denominator, not about the rows. A window with rows
       but no model calls has nothing to measure quality against, and calling
       that a trend would be the exact mistake this file exists to avoid. */
    empty: weeksOut.every((w) => w.modelCalls === 0),
  };
}
