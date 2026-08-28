/**
 * Run the insight questions for one reader, as that reader.
 *
 * THE ACCESS RULE, AND IT IS THE WHOLE DESIGN. Every question is asked with the
 * caller's own user id, so retrieval is scoped by their permissions and
 * SharePoint applies its own. There is no privileged path here and there must
 * never be one: an insight panel that surfaced a document somebody was not
 * allowed to open would be a disclosure, and the only reliable way to prevent
 * that is to never hold the ability to do it.
 *
 * SEQUENTIAL, NOT PARALLEL. Six questions fired at once would put six
 * simultaneous retrievals plus their Graph calls against one tenant, which is
 * how a dashboard load turns into a rate limit. They run in order and the whole
 * run is bounded, because a panel that takes a minute is a panel nobody waits
 * for. Measured on the same day this was written: one slow search provider took
 * 22 seconds at p95 and made the whole search look broken.
 *
 * NEVER THROWS. A question that fails becomes a finding that says so. The panel
 * is more useful with five answers and one honest failure than with an error
 * page, and a client reading "we could not answer this" learns something true.
 */

import { chat } from "@/lib/assistant";
import { trackEvent } from "@/lib/analytics";
import {
  DATA_QUESTIONS,
  isEmptyAnswer,
  type DataQuestion,
  type Finding,
} from "./data-questions";

/**
 * The whole run's budget.
 *
 * Past this, remaining questions are reported as not-run rather than left
 * spinning. Chosen so the panel renders inside the time somebody will wait for
 * a dashboard, and honest about what it skipped.
 */
const RUN_BUDGET_MS = 25_000;

export interface InsightRun {
  findings: Finding[];
  /** Questions that were not reached before the budget ran out. */
  skipped: string[];
  tookMs: number;
}

export async function runDataQuestions(
  userId: string,
  userRole: string,
  questions: DataQuestion[] = DATA_QUESTIONS,
): Promise<InsightRun> {
  const started = Date.now();
  const findings: Finding[] = [];
  const skipped: string[] = [];

  for (const q of questions) {
    if (Date.now() - started > RUN_BUDGET_MS) {
      /* NAMED, NOT DROPPED. A question quietly missing from the panel reads as
         a question we chose not to ask. */
      skipped.push(q.id);
      continue;
    }

    const qStarted = Date.now();
    try {
      const res = (await chat(q.ask, userId, userRole)) as {
        response?: string;
        source?: string;
      };
      const answer = (res.response ?? "").trim();
      findings.push({
        id: q.id,
        title: q.title,
        why: q.why,
        ask: q.ask,
        answer,
        source: res.source ?? "unknown",
        empty: isEmptyAnswer(answer),
        tookMs: Date.now() - qStarted,
      });
    } catch (err) {
      findings.push({
        id: q.id,
        title: q.title,
        why: q.why,
        ask: q.ask,
        answer: `This one could not be answered just now: ${
          (err as Error).message?.slice(0, 120) ?? "unknown error"
        }`,
        source: "error",
        empty: true,
        tookMs: Date.now() - qStarted,
      });
    }
  }

  const tookMs = Date.now() - started;

  /* The empty count is the useful number here: it is how much of their corpus
     we cannot yet answer from, which is the gap a pilot is meant to close. */
  try {
    trackEvent("insights.data_questions_run", userId, userRole, {
      asked: findings.length,
      empty: findings.filter((f) => f.empty).length,
      skipped: skipped.length,
      took_ms: tookMs,
    });
  } catch {
    /* Analytics is best effort; the findings are the product. */
  }

  return { findings, skipped, tookMs };
}
