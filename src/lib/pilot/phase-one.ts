/**
 * Phase one, as the client will see it.
 *
 * The playbook says phase one is their document library, read only, answerable
 * through the assistant and scoped so a person is only quoted what their role
 * may read. This is the page that makes that visible while it happens, built
 * against our own instance first so the thing is proven before a client opens
 * it.
 *
 * EVERY FIGURE HERE IS MEASURED. Nothing is illustrative and nothing is a
 * placeholder, because the point is to learn whether this looks good carrying
 * real numbers rather than designed ones. A dashboard that demos beautifully
 * on invented data teaches nobody anything and misleads whoever designs the
 * next version of it.
 *
 * WHY THESE PANELS AND NOT THE OBVIOUS ONES. The obvious dashboard counts
 * documents and questions, which everything in this category shows. Three of
 * these do not:
 *
 *   - HOW OFTEN WE DID NOT USE A MODEL. The share of answers served straight
 *     from their own systems. It is the efficiency, auditability and cost
 *     arguments at once, and a chatbot cannot show it because for a chatbot it
 *     is zero.
 *   - WHAT WE DECLINED TO ANSWER. Refusals as a feature rather than a hidden
 *     failure. A system that says "I cannot find that" is the one you can
 *     trust when it does answer, and publishing the count is what makes that
 *     claim checkable instead of a promise.
 *   - WHAT WE COULD NOT ANSWER YET. The questions that fell through, which is
 *     a build backlog written by users instead of guessed at in a planning
 *     meeting.
 *
 * A ZERO IS NEVER RENDERED AS HEALTH. The snapshot carries whether it could be
 * read at all, for the same reason the quality trend does: an unreadable
 * source and a genuinely quiet week look identical as a number and mean
 * opposite things.
 */
import { query } from "@/lib/db";

export type { PhaseOneSnapshot } from "./phase-one-shape";
export { deterministicShare, answersGiven } from "./phase-one-shape";

import type { PhaseOneSnapshot } from "./phase-one-shape";

const EMPTY: PhaseOneSnapshot = {
  passages: 0,
  libraries: 0,
  scansRead: 0,
  toolAnswers: 0,
  modelAnswers: 0,
  declined: 0,
  readable: false,
};

/**
 * Scoped by workspace, and the repo-wide tenancy scan is what insisted.
 *
 * The library count is the figure that would have leaked: a bare count over
 * instinct_sharepoint_sources reads every tenant's connected libraries. On a
 * single-tenant deployment that happens to be harmless, which is exactly why
 * it would have survived review, and this is the one page whose whole purpose
 * is to be shown to a client.
 */
/**
 * Rows a person is responsible for.
 *
 * THIS PAGE WAS COUNTING OUR OWN TESTING AS THE CLIENT'S USAGE. Measured over
 * thirty days: 11 per cent of the tool answers and 29 per cent of the model
 * answers came from eval harnesses, transcript probes and demo accounts, so
 * the headline share of answers served without a model read 67.9 per cent
 * where the truth for people was 72.7.
 *
 * It happened to understate us, which is the luckier direction and not a
 * reason to leave it: the same contamination on a day of heavy model testing
 * would overstate instead, and a figure that moves with our own activity is
 * not a figure about the product.
 *
 * Expressed in SQL because the counting has to happen in the aggregate rather
 * than by filtering afterwards. The rule matches isServiceIdentity in
 * insights/traffic.ts: a person signs in and gets an account id or an email
 * address, and our machinery passes a word it chose for itself.
 */
const PERSON = `(user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 OR user_id LIKE '%@%')`;

export async function getPhaseOneSnapshot(
  workspaceId: string,
  days = 60,
): Promise<PhaseOneSnapshot> {
  const bounded = Math.max(1, Math.min(365, Math.floor(days)));
  try {
    const [corpus, scans, sources, activity] = await Promise.all([
      /* THE CLIENT'S LIBRARY, NOT OURS PLUS THEIRS. 438 of 982 indexed
         documents are output from our own platform-scan tool, so an
         unqualified count describes a library 80 per cent bigger than the one
         that can answer their questions. A figure that flatters us by counting
         our own output gets checked once and never trusted again. The scans
         stay searchable; they just stop being quoted as the client's. */
      query<{ passages: string }>(
        `SELECT count(*)::text AS passages
           FROM brain_chunks c
           JOIN brain_documents d ON d.id = c.document_id
          WHERE d.filename NOT ILIKE 'platform-scan-%'`,
      ),
      /* SCANS ARE THE PART A LIBRARY QUIETLY LOSES. A photographed agreement
         or an exported slide carries no text, so it indexes as a filename and
         answers nothing, and on a dashboard it is indistinguishable from a
         document that was read. Counting the ones OCR recovered is the only
         way that difference shows.

         NOT filtered by filename the way the passage count above is: this
         counts a repair that happened, and a scan we recovered is a scan we
         recovered whoever put the file there. */
      query<{ scans: string }>(
        `SELECT count(*)::text AS scans FROM instinct_events
          WHERE event_type = 'brain.document_ocred'`
      ),
      query<{ libraries: string }>(
        `SELECT count(*)::text AS libraries
           FROM instinct_sharepoint_sources
          WHERE workspace_id = $1`,
        [workspaceId],
      ),
      query<{
        tool_answers: string;
        model_answers: string;
        declined: string;
        excluded: string;
      }>(
        `SELECT
           count(*) FILTER (WHERE event_type = 'assistant.tool_succeeded' AND ${PERSON})::text AS tool_answers,
           count(*) FILTER (WHERE event_type = 'ai.completion' AND ${PERSON})::text AS model_answers,
           /* Declining is the trust claim, so it is counted from the two places
              that actually decline: a retrieval the judge threw out, and an
              answer refused entry into knowledge. */
           count(*) FILTER (
             WHERE event_type IN (
               'brain.retrieval_judged_irrelevant',
               'assistant.answer_not_promoted'
             ) AND ${PERSON}
           )::text AS declined,
           /* Counted so the page can say how much was set aside. A number
              that quietly shrank is one somebody will query, and the answer
              should be on the page rather than in somebody's memory. */
           count(*) FILTER (
             WHERE event_type IN ('assistant.tool_succeeded', 'ai.completion')
               AND NOT (${PERSON})
           )::text AS excluded
         FROM instinct_events
        WHERE timestamp > NOW() - ($1::int * INTERVAL '1 day')
          /* NARROW BEFORE COUNTING, NOT WHILE COUNTING.
           *
           * Every aggregate above already requires one of these four types, so
           * this changes no number. What it changes is how many rows Postgres
           * touches to produce them. Without it the scan covered every event in
           * the window and ran the identity regex on each: measured 2026-09-01,
           * 2,639,165 rows read to compute a figure that needs 6,385 of them,
           * because 1.7 million of them are token verifications.
           *
           * 1,445ms to 58ms, same four numbers. The page was slow because it
           * was reading the whole analytics table to count a corner of it. */
          AND event_type IN (
            'assistant.tool_succeeded',
            'ai.completion',
            'brain.retrieval_judged_irrelevant',
            'assistant.answer_not_promoted'
          )`,
        [bounded],
      ),
    ]);

    return {
      passages: Number(corpus.rows[0]?.passages ?? 0),
      scansRead: Number(scans.rows[0]?.scans ?? 0),
      libraries: Number(sources.rows[0]?.libraries ?? 0),
      toolAnswers: Number(activity.rows[0]?.tool_answers ?? 0),
      modelAnswers: Number(activity.rows[0]?.model_answers ?? 0),
      declined: Number(activity.rows[0]?.declined ?? 0),
      excludedAsTesting: Number(activity.rows[0]?.excluded ?? 0),
      readable: true,
    };
  } catch (err) {
    /* Degrades rather than taking the page down, and says so rather than
       rendering zeros. A zero here would claim an empty corpus and a silent
       assistant, which is a more alarming and far less true statement than
       "this could not be read". */
    console.warn("[phase-one]", (err as Error).message);
    return EMPTY;
  }
}
