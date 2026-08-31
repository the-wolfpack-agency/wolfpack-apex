/**
 * Telling a habit from a burst.
 *
 * WHAT THIS CAUGHT, AFTER TWO EARLIER ATTEMPTS FAILED TO. One document
 * appeared to have answered 754 questions, which would have been the headline
 * of a client report: a single point of failure nobody knew about.
 *
 * The first pass blamed test traffic and excluded the harnesses that identify
 * themselves by name. 710 of the 754 survived, so the finding looked real.
 *
 * It was not. 609 of those 710 came from two identities on two days. They are
 * automated runs that happened to be issued account ids, so nothing about
 * WHO was asking could distinguish them from people. What distinguishes them
 * is that they all happened at once.
 *
 * A DOCUMENT EVERYBODY LEANS ON LOOKS DIFFERENT FROM ONE SOMEBODY HAMMERED.
 * Reliance is several people returning to something across many days. A
 * thousand uses by two identities in forty-eight hours is an event, and
 * reporting it as reliance tells a client to protect a document their team
 * has barely opened.
 *
 * IT GENERALISES PAST OUR OWN MESS. A client will have bursts too: a
 * migration, an audit, one person preparing a board pack, a script somebody
 * wrote. None of them is a habit, and all of them dominate a count.
 */

export interface UsageRow {
  /** Who used it. */
  actor: string;
  /** The day it happened, as an ISO date. */
  day: string;
}

export interface SustainedReading {
  total: number;
  actors: number;
  days: number;
  /** Uses left after the sittings that account for half of them are set aside. */
  sustained: number;
  /** How many sittings account for half the use. */
  sittingsForHalf: number;
  /** Total distinct person-days this was used on. */
  sittings: number;
  /** Days spanned by the sittings that hold half. Small means one push. */
  heavySpanDays: number;
  /** True when this looks like a habit rather than an event. */
  isSustained: boolean;
}

/**
 * How much of this usage is a pattern rather than a moment.
 *
 * MEASURED ACROSS SITTINGS, NOT ONE. The first version removed the single
 * busiest actor-day and asked whether it held more than forty per cent. On
 * the document that motivated all of this it held thirty, so the check passed
 * and called it a habit, while the top TWO sittings held fifty-eight per cent
 * and four held eighty-six. One outlier is rarely the shape of a burst;
 * several are.
 *
 * AND THE SECOND VERSION CALLED EVERYTHING A BURST. Counting how few sittings
 * hold half sounds right and is not: real usage has a long tail, so a handful
 * of busy days always holds half, and a document five people returned to over
 * thirty-six days was reported as an event.
 *
 * What actually separates them is WHEN the heavy days fall. A habit's busiest
 * days are scattered through the period; a burst's are next to each other,
 * because it was one piece of work. The 754 that started this had its four
 * largest sittings on two consecutive days inside a fifteen-day span.
 */
export const MIN_ACTORS_FOR_A_HABIT = 3;
export const MIN_DAYS_FOR_A_HABIT = 5;
/** Sittings holding this share are the ones examined for clustering. */
export const HALF = 0.5;
/**
 * Days within which the dominant sittings must fall to count as one piece of
 * work.
 *
 * Three. A migration, an audit or somebody preparing a board pack happens
 * over a day or two; a habit's busy days are weeks apart.
 */
export const BURST_WINDOW_DAYS = 3;

export function readSustained(rows: readonly UsageRow[]): SustainedReading {
  const total = rows.length;
  if (total === 0) {
    return {
      total: 0,
      actors: 0,
      days: 0,
      sustained: 0,
      sittingsForHalf: 0,
      sittings: 0,
      heavySpanDays: 0,
      isSustained: false,
    };
  }

  const byActorDay = new Map<string, number>();
  const actors = new Set<string>();
  const days = new Set<string>();

  for (const r of rows) {
    actors.add(r.actor);
    days.add(r.day);
    const key = `${r.actor}|${r.day}`;
    byActorDay.set(key, (byActorDay.get(key) ?? 0) + 1);
  }

  /* Largest sittings first, keeping their dates, so the ones that dominate can
     be asked WHEN they happened rather than only how many they are. */
  const sittingList = [...byActorDay.entries()]
    .map(([key, count]) => ({ day: key.split("|")[1], count }))
    .sort((a, b) => b.count - a.count);

  let running = 0;
  let sittingsForHalf = 0;
  const heavyDays: number[] = [];
  for (const sitting of sittingList) {
    running += sitting.count;
    sittingsForHalf += 1;
    const t = Date.parse(sitting.day);
    if (!Number.isNaN(t)) heavyDays.push(t);
    if (running / total >= HALF) break;
  }

  /* THE DISCRIMINATOR. A habit's busiest days are scattered through the
     period; a burst's sit next to each other, because it was one piece of
     work. */
  const heavySpanDays =
    heavyDays.length === 0
      ? 0
      : (Math.max(...heavyDays) - Math.min(...heavyDays)) / 86_400_000 + 1;
  const concentrated = heavySpanDays > 0 && heavySpanDays <= BURST_WINDOW_DAYS && days.size > BURST_WINDOW_DAYS;

  return {
    total,
    actors: actors.size,
    days: days.size,
    /* What is left once the dominating sittings are set aside, which is the
       figure worth quoting when the total is not. */
    sustained: total - running,
    sittingsForHalf,
    sittings: sittingList.length,
    heavySpanDays,
    isSustained:
      actors.size >= MIN_ACTORS_FOR_A_HABIT &&
      days.size >= MIN_DAYS_FOR_A_HABIT &&
      !concentrated,
  };
}

/**
 * What to say about a count before anybody acts on it.
 *
 * The sustained figure leads when the pattern is real, and the raw total leads
 * nowhere when it is not: a number that describes one afternoon should not be
 * offered as a description of a team.
 */
export function describeSustained(label: string, r: SustainedReading): string {
  if (r.total === 0) return `${label}: never used.`;

  if (r.isSustained) {
    return `${label}: used ${r.total} time(s) by ${r.actors} people across ${r.days} days. That is a habit, and losing it would be felt.`;
  }

  return (
    `${label}: used ${r.total} time(s), but half of that fell inside ${Math.round(r.heavySpanDays)} day(s) ` +
    `of a ${r.days}-day span, across ${r.actors} people. That is an event rather than a habit ` +
    `(a migration, an audit, somebody preparing something), and the total describes that event. ` +
    `Sustained use is nearer ${r.sustained}.`
  );
}
