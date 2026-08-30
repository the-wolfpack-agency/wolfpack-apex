/**
 * What happened to a person AFTER the answer.
 *
 * THE GAP THIS FILLS. The product emits 133 assistant events and every one of
 * them describes what the SYSTEM did: which tool ran, what it retrieved, what
 * it refused, what it cost. Not one describes what the PERSON did in response,
 * and the response is where frustration lives. The only exception was
 * meeting_prep_source_clicked: one click, on one widget.
 *
 * That is why the customer-success view could only say "joined and has done
 * nothing since". It is the crudest possible behavioural signal because it was
 * the only one.
 *
 * MEASURED ON 90 DAYS OF PRODUCTION, 2026-08-30:
 *
 *     12,201 conversations, 24,395 messages
 *     one question then gone          12,122   99.4%
 *     answers that admitted a miss       501
 *     ...person never came back          483   96% of misses
 *     answers rated at all                 3   0.01%
 *
 * DERIVED, NOT INSTRUMENTED, AND THAT IS THE POINT. Every figure above comes
 * from rows the product has stored since day one. Adding an event for these
 * would start the count at zero today and learn nothing about the last three
 * months; deriving them reads the whole history. Only genuinely browser-side
 * facts, a copy or a source click, need a new event, and those live elsewhere.
 *
 * RATINGS ARE NOT THE ANSWER, AND THAT IS SETTLED. Every time outcome labels
 * come up as the scarce input, the obvious proposal is to get more people to
 * rate answers. Measured 2026-08-30, so nobody has to re-litigate it:
 *
 *     knowledge.answer_rated events        27      last 2026-08-04
 *     messages carrying a rating           14
 *     assistant messages in the corpus 16,332
 *     conversations with no owner           0      so nothing is blocked
 *
 * The control WORKS. Twenty-seven rate actions across fourteen messages in the
 * product's life, none in the last twenty-six days. People do not rate
 * answers, they act on them or they leave, and a product that needs them to
 * rate in order to learn will not learn.
 *
 * Which is why the labels here are DERIVED and why the two browser-only
 * signals are a copy and a source click. Both are things somebody does for
 * their own reasons, and neither requires anybody to be asked.
 *
 * WHAT THIS DELIBERATELY WILL NOT CONCLUDE. "One question then gone" is not a
 * frustration metric. It means either somebody got what they needed in one
 * question or they gave up, and those are opposite readings of one number.
 * This reports it as ambiguous and says so, rather than picking the flattering
 * half. Disambiguating it is what the copy and source-click events are for.
 */

import { query } from "@/lib/db";

/**
 * Sentences the product emits when it has nothing.
 *
 * Taken from the code that produces them rather than invented: the search
 * tool's empty result, the bare fallback, the low-confidence rejection and the
 * not-connected reply. Matching on prose is fragile, which is why the strings
 * are pinned by a test that fails if the product's wording moves.
 */
export const MISS_PATTERNS: RegExp[] = [
  /^No results found for/i,
  /I don't have information on that yet/i,
  /I don't have a confident answer/i,
  /I do not have anything on that yet/i,
  /is not connected yet/i,
  /* THE MODEL WRITES ITS OWN WAYS OF SAYING "I DO NOT KNOW", and the first
   * version of this list only knew the deterministic ones. Found by walking
   * every distinct answer in a 90-day window and reading the ones that sound
   * like a failure but matched nothing:
   *
   *   "I cannot determine who runs engineering based on the information
   *    provided."
   *
   * Those landed in single_turn and read as neutral, which means the measured
   * bad rate for origin=ai (39.3%) was UNDERSTATED: the worst-performing
   * origin was the one whose failures were hardest to see, because it is the
   * only one that phrases them differently every time.
   *
   * Deliberately anchored on the refusal itself rather than on any topic, so
   * a document that happens to contain "cannot determine" is not swept up. */
  /\bI (?:cannot|can't|could not|couldn't) (?:determine|find|locate|tell)\b/i,
  /\bbased on the (?:information|data) provided[,.]? I (?:cannot|can't|do not|don't)\b/i,
  /\bthere (?:are|is) no (?:records?|results?|matching)\b/i,
];

/**
 * Sentences that mean something BROKE, which is not the same as having
 * nothing. Separated because the fix is different: a miss is a gap in the
 * corpus, an outage is a gap in the plumbing, and counting them together would
 * send somebody to load more documents when the search index is down.
 */
export const OUTAGE_PATTERNS: RegExp[] = [
  /I could not reach the search index/i,
  /I could not reach the model that writes answers/i,
];

/**
 * The product asking WHICH document was meant.
 *
 * Not a miss. A miss is "I have nothing"; this is "I have several and I will
 * not guess between them", which is the correct answer to a question with no
 * subject. Classified apart so an honest question is never counted as a
 * failure: doing so would teach every downstream measure to prefer the
 * confident wrong answer it replaced.
 */
export const ASKED_WHICH_PATTERNS: RegExp[] = [
  /the closest things I hold are/i,
  /the closest thing I hold is/i,
];

export function isAskedWhich(text: string): boolean {
  const t = (text ?? "").trim();
  return t.length > 0 && ASKED_WHICH_PATTERNS.some((r) => r.test(t));
}

export function isMiss(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (OUTAGE_PATTERNS.some((r) => r.test(t))) return false;
  /* Asking which is not admitting nothing, and the two overlap in wording:
     the ask opens "I could not find a clear answer", which reads like a miss
     and is the opposite of one. */
  if (isAskedWhich(t)) return false;
  return MISS_PATTERNS.some((r) => r.test(t));
}

export function isOutage(text: string): boolean {
  return OUTAGE_PATTERNS.some((r) => r.test((text ?? "").trim()));
}

/** Word overlap, so a rephrase counts even when the words move around. */
export function similarity(a: string, b: string): number {
  const words = (s: string) => new Set((s ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

/** A rephrase this soon after the last one is a retry, not a new question. */
export const REASK_WINDOW_SECONDS = 300;
/** Below this the two questions are just about the same topic. */
export const REASK_SIMILARITY = 0.5;

export interface AnswerOutcomes {
  /** False when the store could not be read, so a zero is never invented. */
  readable: boolean;
  days: number;
  conversations: number;
  messages: number;
  /** Answers that admitted having nothing. */
  misses: number;
  /** Misses after which the person never asked anything again. */
  deadEnds: number;
  /** Misses the person pushed past, which is the recoverable case. */
  missesFollowedUp: number;
  /** A question asked again in different words within the window. */
  reAsks: number;
  /** Conversations containing at least one re-ask. */
  reAskConversations: number;
  /**
   * One question and no more. Reported WITHOUT a verdict: it means either
   * satisfied or gave up, and nothing here can tell which.
   */
  singleTurnConversations: number;
  /** Answers a person rated at all. The control is only worth keeping if used. */
  ratedAnswers: number;
}

interface MessageRow extends Record<string, unknown> {
  conversation_id: string;
  role: string;
  content: string;
  rating: number | null;
  created_at: string;
}

/**
 * Read the whole history and say what happened after each answer.
 *
 * One query and an in-memory pass rather than SQL window functions, because
 * the similarity test is word-set overlap and pushing that into Postgres would
 * mean depending on pg_trgm being installed. It is a read of one table over a
 * bounded window, and the alternative is a dependency that fails at runtime on
 * a client's database rather than here.
 */
export async function readAnswerOutcomes(days = 90): Promise<AnswerOutcomes> {
  const empty: AnswerOutcomes = {
    readable: false,
    days,
    conversations: 0,
    messages: 0,
    misses: 0,
    deadEnds: 0,
    missesFollowedUp: 0,
    reAsks: 0,
    reAskConversations: 0,
    singleTurnConversations: 0,
    ratedAnswers: 0,
  };

  let rows: MessageRow[];
  try {
    const result = await query<MessageRow>(
      `SELECT conversation_id, role, content, rating, created_at
         FROM instinct_messages
        WHERE created_at > NOW() - INTERVAL '1 day' * $1
        ORDER BY conversation_id, created_at
        LIMIT 200000`,
      [days],
    );
    rows = result.rows;
  } catch {
    /* readable:false, never zeros. An unreadable store and a quiet quarter
       look identical otherwise, which is the defect this whole module exists
       to stop shipping. */
    return empty;
  }

  return summariseOutcomes(rows, days);
}

/** Split out so the arithmetic is testable without a database. */
export function summariseOutcomes(rows: MessageRow[], days: number): AnswerOutcomes {
  const byConversation = new Map<string, MessageRow[]>();
  for (const m of rows) {
    const list = byConversation.get(m.conversation_id);
    if (list) list.push(m);
    else byConversation.set(m.conversation_id, [m]);
  }

  let misses = 0;
  let deadEnds = 0;
  let reAsks = 0;
  let reAskConversations = 0;
  let singleTurn = 0;
  let rated = 0;

  for (const messages of byConversation.values()) {
    const asked = messages.filter((m) => m.role === "user");
    if (asked.length === 1) singleTurn += 1;

    let hadReAsk = false;
    for (let i = 1; i < asked.length; i += 1) {
      const gap =
        (new Date(asked[i].created_at).getTime() - new Date(asked[i - 1].created_at).getTime()) /
        1000;
      if (gap >= 0 && gap < REASK_WINDOW_SECONDS) {
        if (similarity(asked[i].content, asked[i - 1].content) >= REASK_SIMILARITY) {
          reAsks += 1;
          hadReAsk = true;
        }
      }
    }
    if (hadReAsk) reAskConversations += 1;

    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      if (m.rating !== null && m.rating !== undefined) rated += 1;
      if (!isMiss(m.content)) continue;
      misses += 1;
      /* A dead end is a miss with nothing after it. The person read "I have
         nothing on that" and stopped, which is the request nobody filed. */
      const cameBack = messages.slice(i + 1).some((later) => later.role === "user");
      if (!cameBack) deadEnds += 1;
    }
  }

  return {
    readable: true,
    days,
    conversations: byConversation.size,
    messages: rows.length,
    misses,
    deadEnds,
    missesFollowedUp: misses - deadEnds,
    reAsks,
    reAskConversations,
    singleTurnConversations: singleTurn,
    ratedAnswers: rated,
  };
}
