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

/* ---------------------------------------------------------------------------
 * Reading the trend, rather than printing it
 *
 * The panel above this data used to be a seven-column table with one row per
 * week, under the title "Is it getting better" and a subtitle promising that
 * "every column is something the product stopped before a person saw it".
 * Three separate problems, all of which a reader hit at once:
 *
 * 1. IT DID NOT ANSWER ITS OWN QUESTION. Seven of the eight weeks carried
 *    almost no model traffic (5, 20, 67 calls) and the eighth carried 584.
 *    Forty-two of the fifty-six cells were 0. A reader was handed a grid of
 *    zeros and left to compute a direction that the data does not support.
 *
 * 2. THE SUBTITLE WAS FALSE FOR HALF THE COLUMNS. Model calls is a
 *    denominator. Answers-a-second-model-checked is a check. Neither stops
 *    anything. Only three of the six were interdictions.
 *
 * 3. ONE LABEL ASSERTED A BLOCK THAT DOES NOT HAPPEN. "Unsafe answers
 *    stopped" reads as interdiction; the router explicitly records these and
 *    delivers the answer, which its own comment says in as many words
 *    ("Recorded rather than blocked"). On a page a client reads, that is the
 *    product claiming a control it does not exercise.
 *
 * So: classify every signal by what actually happens to the answer, compare
 * like with like, and refuse to state a direction the volume cannot support.
 * ------------------------------------------------------------------------- */

/** What the product actually did to the answer, which is not the same for
 *  every counter and was previously flattened into one claim. */
export type SignalEffect =
  /** The answer a person read was changed, or the input never reached it. */
  | "blocked"
  /** An audit row was written. The answer was delivered as the model wrote it. */
  | "recorded"
  /** Neither: this is the volume the checks ran against. */
  | "volume";

export type SignalTrend =
  | "up"
  | "down"
  | "flat"
  /** The window carried too little model traffic to compare anything. */
  | "insufficient"
  /**
   * There was traffic, but THIS signal never fired before the latest week.
   *
   * Kept separate from "insufficient" because the two have different causes
   * and different answers. Every quality event in this window first fired on
   * 2026-08-25, when the checks that emit them shipped. Comparing a week that
   * has a check against weeks that did not measures the deployment date and
   * reports it as a quality improvement, which is the most flattering wrong
   * number this panel could produce.
   */
  | "no-baseline";

/**
 * Below this many model calls a week is not a sample, it is an anecdote.
 *
 * Set against the real history rather than picked for roundness: the eight
 * weeks on record run 0, 0, 0, 20, 5, 67, 584. Any floor between 68 and 584
 * gives the same answer here, and this one states plainly that a fifty-call
 * week cannot carry a quality claim.
 */
export const MIN_VOLUME_FOR_TREND = 100;

export interface QualitySignal {
  key: "flagged" | "reviewed" | "corrected" | "irrelevantRetrievals" | "notPromoted";
  /** Names the event, not the field, and never overstates the effect. */
  label: string;
  effect: SignalEffect;
  /** Count in the most recent week. */
  latest: number;
  /** Count across every earlier week in the window. */
  prior: number;
  /** Rate per 1,000 model calls, or null when nothing was checked. */
  latestRate: number | null;
  priorRate: number | null;
  trend: SignalTrend;
  /** What a reader should take from this row, including when the answer is
   *  "you cannot tell yet". */
  reading: string;
}

export interface QualitySummary {
  signals: QualitySignal[];
  latestWeek: string | null;
  latestVolume: number;
  priorVolume: number;
  /** True when both sides of the comparison clear MIN_VOLUME_FOR_TREND. */
  comparable: boolean;
  /** The honest one-line answer to "is it getting better". */
  verdict: string;
}

function rate(count: number, volume: number): number | null {
  return volume > 0 ? (count / volume) * 1000 : null;
}

/* A five percent band. Two rates either side of it are the same rate read
   twice, and calling that a direction is how a dashboard manufactures a
   trend out of rounding. */
const FLAT_BAND = 0.05;

function trendOf(
  latest: number | null,
  prior: number | null,
  priorCount: number,
  comparable: boolean,
): SignalTrend {
  if (!comparable || latest === null || prior === null) return "insufficient";
  /* Nothing on either side is a real, readable flat: the check ran and found
     nothing, both then and now. */
  if (priorCount === 0 && latest === 0) return "flat";
  /* Something now, nothing ever before. Cannot be told apart from the check
     having started this week, so it is not called a rise. */
  if (priorCount === 0) return "no-baseline";
  const delta = (latest - prior) / prior;
  if (Math.abs(delta) < FLAT_BAND) return "flat";
  return delta > 0 ? "up" : "down";
}

/** Ordered so the three real interdictions come first: a reader who stops
 *  after the top of the panel has read the part that is load-bearing. */
const SIGNALS: Array<{
  key: QualitySignal["key"];
  label: string;
  effect: SignalEffect;
  /** Said when there is enough volume to compare. */
  up: string;
  down: string;
  flat: string;
  /** Said when there is not, which is the current state and not a defect. */
  insufficient: string;
  /** Said when this signal has no earlier occurrence to compare against. */
  "no-baseline": string;
}> = [
  {
    key: "corrected",
    label: "Answers a second model rewrote before delivery",
    effect: "blocked",
    up: "The reviewer is changing more answers. That is the check earning its cost, and it is also worth watching: if it rises while the number reviewed holds, the drafting model got worse.",
    down: "The reviewer is changing fewer answers, which is what a drafting model getting better looks like.",
    flat: "The reviewer is changing answers at the same rate as before.",
    insufficient: "A second model rewrote these before anyone read them. There is not enough earlier traffic to say whether that rate is moving.",
    "no-baseline":
      "This is the first week these were recorded, so there is nothing earlier to compare against. The count is real; a direction would only be measuring when the reviewer shipped.",
  },
  {
    key: "irrelevantRetrievals",
    label: "Documents retrieval pulled and the judge threw out",
    effect: "blocked",
    up: "More retrieved documents are being discarded, which points at retrieval rather than at the model.",
    down: "Fewer documents are being discarded, which is what retrieval improving looks like. Worth confirming the judge still runs: this number also falls when the check stops.",
    flat: "Documents are being discarded at the same rate as before.",
    insufficient: "These never reached an answer. There is not enough earlier traffic to say whether the rate is moving.",
    "no-baseline":
      "First week on record for this check, so there is no earlier rate to compare against.",
  },
  {
    key: "notPromoted",
    label: "Answers refused entry into the knowledge base",
    effect: "blocked",
    up: "More answers are being refused promotion. This gate caught a fabrication before, so a rise is the gate working, not the product failing.",
    down: "Fewer answers are being refused promotion.",
    flat: "Answers are being refused promotion at the same rate as before.",
    insufficient: "These were kept out of the knowledge base. Zero is not the target here: this gate exists to catch fabrications, so it is meant to fire.",
    "no-baseline":
      "First week on record for this gate, so there is no earlier rate to compare against.",
  },
  {
    key: "flagged",
    label: "Answers carrying a risky shape, logged for audit",
    effect: "recorded",
    up: "More answers are carrying shapes worth auditing.",
    down: "Fewer answers are carrying shapes worth auditing.",
    flat: "Answers are carrying auditable shapes at the same rate as before.",
    insufficient: "The check runs on every model answer and has not matched one yet. That is a true zero rather than a counter that never ran, and the answer is delivered either way: this is an audit record, not a block.",
    "no-baseline":
      "No earlier occurrence to compare against.",
  },
  {
    key: "reviewed",
    label: "Answers a second model read at all",
    effect: "volume",
    up: "More answers are being sent for a second read.",
    down: "Fewer answers are being sent for a second read, which is worth a look if traffic held.",
    flat: "Answers are being sent for a second read at the same rate as before.",
    insufficient: "This is the denominator for the rewrite count above, not a catch of its own.",
    "no-baseline":
      "First week on record, so there is no earlier rate to compare against.",
  },
];

/**
 * Turn eight weeks of counters into something a person can read in one pass.
 *
 * Compares the most recent week against every earlier week in the window,
 * as rates rather than counts, and returns "insufficient" wherever the
 * volume on either side cannot carry the comparison. A dashboard that always
 * prints a direction is a dashboard whose directions cannot be trusted when
 * it matters, so this one declines.
 */
export function summarizeQuality(weeks: QualityWeek[]): QualitySummary {
  if (weeks.length === 0) {
    return {
      signals: [],
      latestWeek: null,
      latestVolume: 0,
      priorVolume: 0,
      comparable: false,
      verdict: "No weeks on record, so there is no trend to read.",
    };
  }

  const latest = weeks[weeks.length - 1];
  const prior = weeks.slice(0, -1);
  const priorVolume = prior.reduce((n, w) => n + w.modelCalls, 0);
  const comparable =
    latest.modelCalls >= MIN_VOLUME_FOR_TREND && priorVolume >= MIN_VOLUME_FOR_TREND;

  const signals = SIGNALS.map((s) => {
    const latestCount = latest[s.key];
    const priorCount = prior.reduce((n, w) => n + w[s.key], 0);
    const latestRate = rate(latestCount, latest.modelCalls);
    const priorRate = rate(priorCount, priorVolume);
    const trend = trendOf(latestRate, priorRate, priorCount, comparable);
    return {
      key: s.key,
      label: s.label,
      effect: s.effect,
      latest: latestCount,
      prior: priorCount,
      latestRate,
      priorRate,
      trend,
      reading: s[trend],
    } satisfies QualitySignal;
  });

  return {
    signals,
    latestWeek: latest.weekStart,
    latestVolume: latest.modelCalls,
    priorVolume,
    comparable,
    /* A direction is worth stating only when at least one signal has an
       earlier occurrence to measure against. Without that, "flat" and "up"
       both describe the checks arriving rather than the answers changing. */
    verdict: comparable && signals.some((x) => x.prior > 0)
      ? `Comparing ${latest.modelCalls.toLocaleString()} model answers this week against ${priorVolume.toLocaleString()} across the previous ${prior.length} weeks.`
      : comparable
      ? `No direction to report yet. No check on this panel has a recorded result from before the week of ${latest.weekStart}, so comparing against the ${priorVolume.toLocaleString()} earlier answers would measure when the checks shipped rather than whether quality moved. The counts below are real.`
      : `Not enough history to call a trend. This week ran ${latest.modelCalls.toLocaleString()} model answers against ${priorVolume.toLocaleString()} across the previous ${prior.length} weeks, and a comparison needs at least ${MIN_VOLUME_FOR_TREND} on each side. The counts below are real; the direction is not yet readable.`,
  };
}
