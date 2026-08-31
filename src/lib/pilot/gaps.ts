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
import { getKnownNames } from "@/lib/pilot/known-names";
import { forDisplay, type Withheld } from "@/lib/pilot/question-display";
import { summarizeWanted, type WantedSummary } from "@/lib/pilot/wanted-actions";
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

export interface GapItem {
  /** Safe to render. Never the raw query. */
  question: string;
  asked: number;
  system?: GapSystem;
  /** Set when the wording was shortened or a name was taken out. */
  withheld?: Withheld;
}

export interface GapsSnapshot {
  /** Questions that would be answered by connecting something. */
  wouldConnect: GapItem[];
  /** Questions a connected system searched and could not answer. */
  missing: GapItem[];
  /** Asked, then answered later. Not a gap, and the best evidence there is. */
  closed: GapItem[];
  /**
   * Things somebody wanted done, as actions rather than as sentences.
   *
   * No text anybody typed renders here. An instruction names the person, the
   * client or the file it is about, and those are the parts the directory mask
   * is least able to reach. See wanted-actions.ts.
   */
  wanted: WantedSummary;
  /**
   * Entries left out because they were statements, not questions.
   *
   * Reported rather than dropped quietly. An exclusion nobody can see is
   * indistinguishable from nobody having asked.
   */
  statements: number;
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
  wanted: { actions: [], other: 0 },
  statements: 0,
  readable: false,
};

/* Three. The panel is a prompt for a conversation, not a backlog: a reader
   who sees five per section reads none of them, and the sections below get
   pushed off the screen by the first one. */
const TOP = 3;

/**
 * Displayable entries, collapsed and ranked.
 *
 * Collapsing happens AFTER the display layer rather than before, because two
 * different people searched for is one fact worth stating once. Counts are
 * summed so the collapse never understates demand.
 */
function shapeAll(items: readonly (Gap | AskedQuestion)[], known: readonly string[]): GapItem[] {
  const byText = new Map<string, GapItem>();
  for (const g of items) {
    const shown = forDisplay(g.query, known);
    /* Not a question. Counted by the caller so the omission is visible rather
       than looking like nobody asked. */
    if (!shown) continue;
    const existing = byText.get(shown.text);
    if (existing) {
      existing.asked += g.asked;
      continue;
    }
    byText.set(shown.text, {
      question: shown.text,
      asked: g.asked,
      ...(shown.withheld ? { withheld: shown.withheld } : {}),
      ...("system" in g ? { system: g.system } : {}),
    });
  }
  return [...byText.values()].sort((a, b) => b.asked - a.asked).slice(0, TOP);
}

/** How many entries in a bucket were statements rather than questions. */
const notQuestions = (items: readonly (Gap | AskedQuestion)[], known: readonly string[]) =>
  items.filter((g) => forDisplay(g.query, known) === null).length;

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
    /* Read once for the whole snapshot rather than per question: it is the same
       directory for every bucket, and the display layer is called hundreds of
       times below. */
    const known = await getKnownNames();
    const buckets = [
      report.wouldBeAnsweredByConnecting,
      report.genuinelyMissing,
      report.closedSince,
      report.askedUsToDoSomething,
    ] as const;

    return {
      wouldConnect: shapeAll(buckets[0], known),
      missing: shapeAll(buckets[1], known),
      closed: shapeAll(buckets[2], known),
      wanted: summarizeWanted(buckets[3], TOP),
      /* The instruction bucket is excluded: its entries are summarized rather
         than left out, and counting them as omissions would overstate what is
         missing from the page. */
      statements: buckets.slice(0, 3).reduce((n, b) => n + notQuestions(b, known), 0),
      readable: true,
    };
  } catch {
    /* silent-ok: readable:false is the signal, and the page renders "could not
       be read" rather than an empty list. Reporting the error text on a
       client's dashboard would say nothing they can act on. */
    return EMPTY;
  }
}
