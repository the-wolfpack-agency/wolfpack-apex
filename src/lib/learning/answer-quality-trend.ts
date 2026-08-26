/**
 * Is the answer quality actually moving, or are we just saying it is?
 *
 * The product records every time it caught something: a retrieval judged
 * irrelevant, an answer refused promotion into knowledge, a response flagged,
 * a draft corrected by a second model. Four events, all written, none ever
 * read. "The trend is measurable" was a claim about the events existing, and a
 * claim nobody can check is indistinguishable from a claim nobody made.
 *
 * A CATCH COUNT WITHOUT ITS DENOMINATOR IS UNREADABLE, and this is the whole
 * reason the shape below is what it is. If flagged responses fall from ten a
 * week to two, that is good news when volume held and hidden bad news when
 * volume collapsed or a checker stopped running. The same number means
 * opposite things. So every signal is returned next to the volume it was
 * measured against, and a rate over a zero denominator is null rather than
 * zero: "nothing happened" and "nothing was checked" must not render alike.
 *
 * WHAT EACH SIGNAL MEANS. They are not interchangeable, and a single "quality
 * score" folding them together would hide the one that moved.
 *
 *   flagged     A response carried a shape we refuse to pass on. Rising is bad.
 *   reviewed    A draft was checked by a second model at all.
 *   corrected   That check changed the answer. Rising means the checker is
 *               earning its cost; rising while `reviewed` is flat means the
 *               drafting model got worse.
 *   irrelevant  Retrieval returned something the judge threw out. Falling
 *               means retrieval improved. Falling to zero means the judge
 *               stopped running, which is why it is shown against volume.
 *   notPromoted An answer was refused entry into knowledge. This is the gate
 *               that caught a fabrication once, so zero is not a target.
 */
import { query } from "@/lib/db";

export interface QualityWeek {
  /** Monday of the week, as a date string. */
  weekStart: string;
  /** The denominator: model calls that week. */
  modelCalls: number;
  flagged: number;
  reviewed: number;
  corrected: number;
  irrelevantRetrievals: number;
  notPromoted: number;
}

export interface QualityTrend {
  weeks: QualityWeek[];
  /** True when no week in the window recorded a single model call. */
  empty: boolean;
}

/**
 * Flagged responses per thousand model calls.
 *
 * Null, never zero, when nothing was called. A rate presented over an empty
 * denominator reads as a clean week to anybody scanning a column of numbers,
 * and that is exactly the week where nothing was being checked.
 */
export function flaggedPerThousand(w: QualityWeek): number | null {
  if (w.modelCalls <= 0) return null;
  return (w.flagged / w.modelCalls) * 1000;
}

/**
 * What share of reviewed answers the reviewer actually changed.
 *
 * Measured against `reviewed` rather than against model calls, because the
 * question this answers is whether the second model is earning its cost, and
 * calls that were never reviewed say nothing about that either way.
 */
export function correctionRate(w: QualityWeek): number | null {
  if (w.reviewed <= 0) return null;
  return w.corrected / w.reviewed;
}

/** Older to newer, so a reader sees the direction rather than infers it. */
export async function getAnswerQualityTrend(weeks = 8): Promise<QualityTrend> {
  const bounded = Math.max(1, Math.min(52, Math.floor(weeks)));
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
    weeks: weeksOut,
    /* Empty is about the denominator, not about the rows. A window with rows
       but no model calls has nothing to measure quality against, and calling
       that a trend would be the exact mistake this file exists to avoid. */
    empty: weeksOut.every((w) => w.modelCalls === 0),
  };
}
