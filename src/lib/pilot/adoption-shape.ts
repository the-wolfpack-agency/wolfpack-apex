/**
 * Who is actually using this, and who quietly stopped.
 *
 * WHY THIS IS ON THE PILOT PAGE. A pilot is judged on adoption, and adoption
 * is the one thing the existing figures cannot show. Passages indexed and
 * answers given describe the product working. They say nothing about whether
 * the people it was bought for have taken it up, and a pilot can post good
 * numbers while most of the team never opened it.
 *
 * The signal that matters most is the quiet one. Measured over sixty days,
 * one person asked the same question thirty-six times, got nothing every time,
 * and stopped. Nobody saw that. It did not appear as an error, a ticket or a
 * complaint. It looked exactly like somebody who had lost interest, and the
 * difference between those two readings is the difference between a product
 * problem and a people problem.
 *
 * SO THE NUMBERS HERE ARE DELIBERATELY UNFLATTERING. Anyone can report active
 * users. This reports who never started, who stopped, and who kept asking
 * without getting an answer, because those are the three the client will
 * otherwise discover for themselves at the end of the pilot.
 */

/** Everything the adoption panel needs, in one readable shape. */
export interface AdoptionSnapshot {
  /** People with an account who could be using it. */
  invited: number;
  /** People who have asked at least one question, ever. */
  everAsked: number;
  /** People who asked in the last seven days. */
  activeRecently: number;
  /**
   * People who used to ask and have not in the last fourteen days.
   *
   * The most actionable number on the page: somebody who tried it and stopped
   * had a reason, and they are still reachable.
   */
  lapsed: number;
  /**
   * Questions that got no useful answer, over the window.
   *
   * Counted so the panel can distinguish "they stopped because it is not
   * useful" from "they stopped because they are busy". The two need entirely
   * different responses.
   */
  unansweredQuestions: number;
  /** A question asked repeatedly and never answered, worst first. */
  repeatedFailures: RepeatedFailure[];
  /** Whether any of this could be read. */
  readable: boolean;
}

/** Somebody trying the same thing over and over and getting nothing. */
export interface RepeatedFailure {
  /** What they asked. Trimmed, never the whole conversation. */
  question: string;
  attempts: number;
}

/**
 * The share of invited people who have ever asked anything.
 *
 * Null rather than zero when nobody was invited, because zero out of zero is
 * not a reach of nought per cent, it is a pilot that has not started.
 */
export function reachedShare(s: AdoptionSnapshot): number | null {
  if (!s.readable || s.invited <= 0) return null;
  return s.everAsked / s.invited;
}

/**
 * How many were invited and never asked anything at all.
 *
 * The silent majority a pilot most needs to see. They are not unhappy; they
 * have simply never had a reason to open it, which is a fixable problem while
 * the pilot is still running.
 */
export function neverStarted(s: AdoptionSnapshot): number | null {
  if (!s.readable) return null;
  return Math.max(0, s.invited - s.everAsked);
}

/** What the panel should say, in one line, without overstating. */
export type AdoptionVerdict =
  | "not_started"
  | "taking_hold"
  | "narrow"
  | "slipping"
  | "unknown";

/**
 * A reading, not a score.
 *
 * Deliberately refuses to produce a number out of ten. A single adoption score
 * invites arguing with the score instead of acting on what it is made of, and
 * every input here is more useful said plainly.
 */
export function adoptionVerdict(s: AdoptionSnapshot): AdoptionVerdict {
  if (!s.readable) return "unknown";
  if (s.everAsked === 0) return "not_started";
  /* Lapsed outnumbering the recently active means the direction is wrong even
     if the totals look healthy. */
  if (s.lapsed > s.activeRecently) return "slipping";
  const reached = reachedShare(s);
  if (reached !== null && reached < 0.5) return "narrow";
  return "taking_hold";
}
