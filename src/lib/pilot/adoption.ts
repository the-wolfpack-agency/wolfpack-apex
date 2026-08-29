/**
 * Read who is using this, from what the product already records.
 *
 * NO NEW TELEMETRY. Every figure comes from instinct_messages and
 * instinct_team_members, both of which already carry what is needed. Adding
 * tracking to measure adoption would be measuring the wrong thing anyway: the
 * point is what people did, not what we thought to instrument.
 *
 * UNREADABLE IS NOT ZERO, the same rule the rest of this directory follows. A
 * failed read reports readable:false and the panel says so, because "nobody
 * used it" and "we could not tell" lead to opposite decisions and a pilot
 * review is the worst place to confuse them.
 */

import { query } from "@/lib/db";
import type { AdoptionSnapshot, RepeatedFailure } from "./adoption-shape";

const EMPTY: AdoptionSnapshot = {
  invited: 0,
  everAsked: 0,
  activeRecently: 0,
  lapsed: 0,
  unansweredQuestions: 0,
  repeatedFailures: [],
  readable: false,
};

/**
 * Answers that told somebody nothing.
 *
 * Matched on the phrases the product actually produces when it has no answer,
 * rather than on a flag, because there is no flag: an unhelpful answer is a
 * normal row. Narrow by design, so an ordinary answer that happens to contain
 * the word "found" is not counted as a failure.
 */
const deadEnd = (col: string) => `(
  ${col} ILIKE 'No results found%'
  OR ${col} ILIKE '%don''t have a confident answer%'
  OR ${col} ILIKE '%not connected yet%'
  OR ${col} ILIKE '%don''t have information on that%'
)`;

export async function getAdoptionSnapshot(
  workspaceId: string,
  days = 60,
): Promise<AdoptionSnapshot> {
  const bounded = Math.max(1, Math.min(365, Math.floor(days)));

  try {
    const [people, activity, failures, deadEnds] = await Promise.all([
      /* Humans only. The roster carries automation accounts, and counting a CI
         service account as an invited colleague would flatter every number on
         this panel. */
      query<{ invited: string }>(
        `SELECT count(*)::text AS invited
           FROM instinct_team_members
          WHERE workspace_id = $1
            AND COALESCE(is_active, TRUE) = TRUE
            AND name !~* '^(test\\b|e2e\\b|ci\\s)'
            AND name !~* '(automated tests?|health bot|smoke|\\bbot\\b)'`,
        [workspaceId],
      ),

      /* One pass over the conversations, bucketing each person by when they
         last asked. Cheaper than three queries and cannot disagree with
         itself. */
      query<{ ever: string; recent: string; lapsed: string }>(
        /* JOINED TO THE SAME PEOPLE THE DENOMINATOR COUNTS.
           Written first without this join, which reported 13 askers against
           10 invited and a reach of 130 per cent. Conversations carry
           automation accounts and users outside this workspace, so the two
           figures described different populations and their ratio was
           meaningless. A share over 100 per cent on a client dashboard is
           worse than no share at all. */
        `WITH asked AS (
           SELECT c.user_id, max(m.created_at) AS last_asked
             FROM instinct_messages m
             JOIN instinct_conversations c ON c.id = m.conversation_id
             JOIN instinct_team_members t ON t.id::text = c.user_id::text
            WHERE m.role = 'user'
              AND m.created_at > NOW() - ($1::int * INTERVAL '1 day')
              AND t.workspace_id = $2
              AND COALESCE(t.is_active, TRUE) = TRUE
              AND t.name !~* '^(test\\b|e2e\\b|ci\\s)'
              AND t.name !~* '(automated tests?|health bot|smoke|\\bbot\\b)'
            GROUP BY c.user_id
         )
         SELECT
           count(*)::text AS ever,
           count(*) FILTER (WHERE last_asked > NOW() - INTERVAL '7 days')::text AS recent,
           count(*) FILTER (WHERE last_asked <= NOW() - INTERVAL '14 days')::text AS lapsed
         FROM asked`,
        [bounded, workspaceId],
      ),

      /* The quiet signal. Somebody asking the same thing repeatedly and never
         getting an answer is the clearest evidence a pilot can produce, and it
         never arrives as a complaint. */
      query<{ question: string; attempts: string }>(
        /* SCOPED TO THIS WORKSPACE, like everything else on this panel.
           Written first without the roster join, which meant it read every
           conversation on the deployment regardless of tenant. On a
           single-tenant deployment that is invisible; on the client's it would
           have put one workspace's questions on another's dashboard, in
           plaintext, on the panel built to be shown in a review. */
        `WITH pairs AS (
           SELECT
             lower(btrim(u.content)) AS question,
             a.content AS answer
           FROM instinct_messages u
           JOIN instinct_conversations c ON c.id = u.conversation_id
           JOIN instinct_team_members t ON t.id::text = c.user_id::text
           JOIN LATERAL (
             SELECT m2.content
               FROM instinct_messages m2
              WHERE m2.conversation_id = u.conversation_id
                AND m2.role = 'assistant'
                AND m2.created_at > u.created_at
              ORDER BY m2.created_at ASC
              LIMIT 1
           ) a ON TRUE
          WHERE u.role = 'user'
            AND u.created_at > NOW() - ($1::int * INTERVAL '1 day')
            AND t.workspace_id = $2
            AND COALESCE(t.is_active, TRUE) = TRUE
            AND t.name !~* '^(test\\b|e2e\\b|ci\\s)'
            AND t.name !~* '(automated tests?|health bot|smoke|\\bbot\\b)'
         )
         SELECT question, count(*)::text AS attempts
           FROM pairs a
          WHERE ${deadEnd("a.answer")}
            /* A BARE STRING OF DIGITS IS NOT SOMEBODY STRUGGLING.
               Reported from the live dashboard 2026-08-29: this panel was
               showing "20x 6601354223758494", "19x 9142133456" and
               "17x 1453674323456767" beside a real one, under the heading
               "somebody who kept trying". They were an operator testing
               whether the product rejects a card-shaped number, and on a
               client-facing page they read as user demand that does not
               exist.

               The panel's whole value is that it is believable, and a
               fabricated-looking entry costs more credibility than the real
               entries earn. A question with no letters in it is not a
               question anybody asked twice in frustration. */
            AND a.question ~ '[a-z]'
            /* Two letters, so a stray character next to a number does not
               readmit the same noise. */
            AND length(regexp_replace(a.question, '[^a-z]', '', 'g')) >= 2
            /* AT LEAST TWO WORDS, AND THE REASON IS NOT GRAMMAR.
               A single bare token is a search term, not a question somebody
               asked twice in frustration, and it is where names surface: the
               live panel was showing "13x wolfpackxpcna", the name of a
               SharePoint site belonging to another client of ours.

               This page is what a prospective client is shown. Telling them
               their product was proved against a different client's material,
               and naming that client, is not a thing to leave to whoever is
               driving the demo. A real question is a sentence; a sentence
               does not usually carry somebody else's account name. */
            AND a.question ~ '[a-z]\\s+\\S'  
          GROUP BY question
         HAVING count(*) > 1
          ORDER BY count(*) DESC
          LIMIT 5`,
        [bounded, workspaceId],
      ),

      /* THE TOTAL IS ITS OWN QUERY, DELIBERATELY.
         It used to ride along as a scalar subquery on the grouped result, so
         it was read from rows[0]. When no question was asked twice the group
         returned no rows at all and the total reported zero, which says the
         product answered everything on exactly the weeks it was failing
         people one question at a time. A count that reads best when the
         evidence is thinnest is worse than no count. */
      query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM instinct_messages u
           JOIN instinct_conversations c ON c.id = u.conversation_id
           JOIN instinct_team_members t ON t.id::text = c.user_id::text
           JOIN LATERAL (
             SELECT m2.content
               FROM instinct_messages m2
              WHERE m2.conversation_id = u.conversation_id
                AND m2.role = 'assistant'
                AND m2.created_at > u.created_at
              ORDER BY m2.created_at ASC
              LIMIT 1
           ) a ON TRUE
          WHERE u.role = 'user'
            AND u.created_at > NOW() - ($1::int * INTERVAL '1 day')
            AND t.workspace_id = $2
            AND COALESCE(t.is_active, TRUE) = TRUE
            AND t.name !~* '^(test\\b|e2e\\b|ci\\s)'
            AND t.name !~* '(automated tests?|health bot|smoke|\\bbot\\b)'
            AND ${deadEnd("a.content")}`,
        [bounded, workspaceId],
      ),
    ]);

    const repeatedFailures: RepeatedFailure[] = failures.rows.map((r) => ({
      /* Trimmed, because a panel is not a transcript and a long question
         pushes the number off the row. */
      question: r.question.slice(0, 120),
      attempts: Number(r.attempts),
    }));

    return {
      invited: Number(people.rows[0]?.invited ?? 0),
      everAsked: Number(activity.rows[0]?.ever ?? 0),
      activeRecently: Number(activity.rows[0]?.recent ?? 0),
      lapsed: Number(activity.rows[0]?.lapsed ?? 0),
      unansweredQuestions: Number(deadEnds.rows[0]?.total ?? 0),
      repeatedFailures,
      readable: true,
    };
  } catch {
    /* A pilot review is the worst place to confuse "nobody used it" with "we
       could not tell". */
    return EMPTY;
  }
}
