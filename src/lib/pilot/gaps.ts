/**
 * What people asked that nothing connected could answer, for the client's page.
 *
 * The insight module already decides which system should have held an answer
 * and separates a question nothing is connected for from one a connected
 * system searched and missed. This reads the log for it and keeps the shape
 * the page needs: small, ranked, and carrying the split.
 *
 * PEOPLE ONLY. Half the query log is our own eval harnesses and demo accounts,
 * and a gap list ranked by our testing tells a client what WE tried rather
 * than what THEY needed.
 *
 * THE TWO KINDS ARE KEPT APART BECAUSE THEY NEED DIFFERENT PEOPLE. "Connect
 * your CRM" is a decision somebody makes in an afternoon. "The answer is not
 * in your documents" is somebody writing one. A single list of failures mixes
 * a sales conversation with a content backlog and produces neither.
 */

import { query } from "@/lib/db";
import {
  buildGapReport,
  type AskedQuestion,
  type Gap,
  type GapSystem,
} from "@/lib/insights/unanswered";

/* Matches isServiceIdentity: a person signs in and gets an account id or an
   email address, and our machinery passes a word it chose for itself. Written
   in SQL because the grouping has to happen on people's rows rather than
   filtering afterwards. */
const PERSON = `(user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 OR user_id LIKE '%@%')`;

export interface GapsSnapshot {
  /** Questions that would be answered by connecting something. */
  wouldConnect: { question: string; asked: number; system: GapSystem }[];
  /** Questions a connected system searched and could not answer. */
  missing: { question: string; asked: number; system: GapSystem }[];
  /** Asked, then answered later. Not a gap, and the best evidence there is. */
  closed: { question: string; asked: number }[];
  /** Instructions rather than questions: things somebody wanted done. */
  wanted: { question: string; asked: number }[];
  /**
   * False when the log could not be read.
   *
   * A failed read and a client with no unanswered questions look identical as
   * an empty list and mean opposite things.
   */
  readable: boolean;
}

const EMPTY: GapsSnapshot = {
  wouldConnect: [],
  missing: [],
  closed: [],
  wanted: [],
  readable: false,
};

const TOP = 5;
const shape = (g: Gap | AskedQuestion) => ({
  question: g.query,
  asked: g.asked,
  ...("system" in g ? { system: g.system } : {}),
});

export async function getGapsSnapshot(
  connected: ReadonlySet<GapSystem>,
  days: number,
): Promise<GapsSnapshot> {
  try {
    /* Misses AND hits per question, so a gap that has since closed can be told
       from one still open. Asking only for misses reports a question as
       missing forever, however many times it has been answered since. */
    const { rows } = await query<{
      query: string;
      misses: string;
      hits: string;
      last: string;
    }>(
      `SELECT lower(trim(query)) AS query,
              count(*) FILTER (WHERE hit_count = 0)::text AS misses,
              count(*) FILTER (WHERE hit_count > 0)::text AS hits,
              max(created_at) FILTER (WHERE hit_count = 0)::date::text AS last
         FROM brain_query_log
        WHERE created_at > now() - ($1 || ' days')::interval
          AND length(trim(query)) > 8
          AND ${PERSON}
        GROUP BY lower(trim(query))
       HAVING count(*) FILTER (WHERE hit_count = 0) > 0
        ORDER BY count(*) FILTER (WHERE hit_count = 0) DESC
        LIMIT 200`,
      [String(days)],
    );

    const asked: AskedQuestion[] = rows.map((r) => ({
      query: r.query,
      asked: Number(r.misses),
      lastAsked: r.last,
      sinceAnswered: Number(r.hits) > 0,
    }));

    const report = buildGapReport(asked, connected);
    return {
      wouldConnect: report.wouldBeAnsweredByConnecting.slice(0, TOP).map(shape) as GapsSnapshot["wouldConnect"],
      missing: report.genuinelyMissing.slice(0, TOP).map(shape) as GapsSnapshot["missing"],
      closed: report.closedSince.slice(0, TOP).map(shape),
      wanted: report.askedUsToDoSomething.slice(0, TOP).map(shape),
      readable: true,
    };
  } catch {
    /* silent-ok: readable:false is the signal, and the page renders "could not
       be read" rather than an empty list. Reporting the error text on a
       client's dashboard would say nothing they can act on. */
    return EMPTY;
  }
}
