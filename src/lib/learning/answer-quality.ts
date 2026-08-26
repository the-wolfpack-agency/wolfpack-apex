/**
 * The SHAPE of the answer-quality trend, and the arithmetic over it.
 *
 * Split from the reader because the router page renders this and the reader
 * imports pg. A client component that transitively pulls in the database
 * driver breaks the build, and it breaks it at a distance from the import
 * that caused it. Types and pure functions here; the query next door.
 *
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
  /**
   * False when the query failed.
   *
   * Kept separate from `empty`, and the distinction is the whole point. A
   * panel that renders zeros when it could not read is worse than one that
   * renders nothing: it reports a clean week, which is precisely the week
   * where nothing was being measured. This is a report, so it degrades rather
   * than taking down the page it sits on, but it degrades out loud.
   */
  readable: boolean;
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
