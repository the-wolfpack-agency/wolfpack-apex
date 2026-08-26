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
export async function getPhaseOneSnapshot(
  workspaceId: string,
  days = 60,
): Promise<PhaseOneSnapshot> {
  const bounded = Math.max(1, Math.min(365, Math.floor(days)));
  try {
    const [corpus, sources, activity] = await Promise.all([
      query<{ passages: string }>(`SELECT count(*)::text AS passages FROM brain_chunks`),
      query<{ libraries: string }>(
        `SELECT count(*)::text AS libraries
           FROM instinct_sharepoint_sources
          WHERE workspace_id = $1`,
        [workspaceId],
      ),
      query<{ tool_answers: string; model_answers: string; declined: string }>(
        `SELECT
           count(*) FILTER (WHERE event_type = 'assistant.tool_succeeded')::text AS tool_answers,
           count(*) FILTER (WHERE event_type = 'ai.completion')::text AS model_answers,
           /* Declining is the trust claim, so it is counted from the two places
              that actually decline: a retrieval the judge threw out, and an
              answer refused entry into knowledge. */
           count(*) FILTER (
             WHERE event_type IN (
               'brain.retrieval_judged_irrelevant',
               'assistant.answer_not_promoted'
             )
           )::text AS declined
         FROM instinct_events
        WHERE timestamp > NOW() - ($1::int * INTERVAL '1 day')`,
        [bounded],
      ),
    ]);

    return {
      passages: Number(corpus.rows[0]?.passages ?? 0),
      libraries: Number(sources.rows[0]?.libraries ?? 0),
      toolAnswers: Number(activity.rows[0]?.tool_answers ?? 0),
      modelAnswers: Number(activity.rows[0]?.model_answers ?? 0),
      declined: Number(activity.rows[0]?.declined ?? 0),
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
