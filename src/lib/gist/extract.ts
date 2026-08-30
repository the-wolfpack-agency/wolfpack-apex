/**
 * Turn real conversations into gists, keeping none of what they said.
 *
 * Reads instinct_messages, pairs each question with the answer it got, works
 * out what happened next, and emits a fixed-vocabulary record. The message
 * text is used to CLASSIFY and is never carried into the output: the gist that
 * leaves this function has no field capable of holding a subject.
 */

import { query } from "@/lib/db";
import {
  isMiss,
  isAskedWhich,
  isOutage,
  similarity,
  REASK_WINDOW_SECONDS,
  REASK_SIMILARITY,
} from "@/lib/insights/answer-outcomes";
import { matchDocumentQuestion } from "@/lib/assistant/tools/search";
import { isQuestionShaped } from "@/lib/brain/question-terms";
import {
  answerOrigin,
  lengthBand,
  questionShape,
  type TurnGist,
  type TurnOutcome,
} from "./features";

interface Row extends Record<string, unknown> {
  conversation_id: string;
  role: string;
  content: string;
  source: string | null;
  created_at: string;
}

/* The product's OWN routing decides the shape, rather than a second set of
   regexes that would drift from it. A content question is one retrieval
   answers; an existence question is one search claims. */
const shapeDeps = {
  isContentQuestion: (q: string) => isQuestionShaped(q),
  isExistenceQuestion: (q: string) => matchDocumentQuestion(q) !== null,
};

export async function extractGists(days = 90): Promise<TurnGist[]> {
  const result = await query<Row>(
    `SELECT conversation_id, role, content, source, created_at
       FROM instinct_messages
      WHERE created_at > NOW() - INTERVAL '1 day' * $1
      ORDER BY conversation_id, created_at
      LIMIT 200000`,
    [days],
  );
  return gistsFrom(result.rows);
}

/** Split out so the pairing logic is testable without a database. */
export function gistsFrom(rows: Row[]): TurnGist[] {
  const byConversation = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byConversation.get(r.conversation_id);
    if (list) list.push(r);
    else byConversation.set(r.conversation_id, [r]);
  }

  const gists: TurnGist[] = [];

  for (const messages of byConversation.values()) {
    const userTurns = messages.filter((m) => m.role === "user");

    for (let i = 0; i < messages.length; i += 1) {
      const answer = messages[i];
      if (answer.role !== "assistant") continue;

      /* The question this answered: the nearest user message before it. */
      let question: Row | null = null;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (messages[j].role === "user") {
          question = messages[j];
          break;
        }
      }
      if (!question) continue;

      const admittedMiss = isMiss(answer.content);
      const laterUser = messages.slice(i + 1).find((m) => m.role === "user");

      /* Was the NEXT thing they typed the same question again? That is the
         clearest "this answer failed me" a person gives without being asked. */
      let reAsked = false;
      if (laterUser) {
        const gap =
          (new Date(laterUser.created_at).getTime() - new Date(question.created_at).getTime()) / 1000;
        if (gap < REASK_WINDOW_SECONDS && similarity(laterUser.content, question.content) >= REASK_SIMILARITY) {
          reAsked = true;
        }
      }

      let outcome: TurnOutcome;
      /* ASKED FIRST, and before re_asked deliberately. Somebody who is asked
         "which of these did you mean" and then names one has been served
         correctly, and their next message is a REPLY rather than a retry. It
         will often look like a rephrase, so classifying the ask first stops a
         working disambiguation being recorded as a failure. */
      /* An outage is checked FIRST. It is the only outcome that describes the
         product breaking rather than the corpus being thin, and its wording
         overlaps with both of the others. */
      if (isOutage(answer.content)) outcome = "degraded";
      else if (isAskedWhich(answer.content)) outcome = "asked_which";
      else if (reAsked) outcome = "re_asked";
      else if (admittedMiss && !laterUser) outcome = "dead_end";
      else if (admittedMiss && laterUser) outcome = "pushed_past";
      else if (laterUser) outcome = "continued";
      else if (userTurns.length === 1) outcome = "single_turn";
      else outcome = "continued";

      gists.push({
        shape: questionShape(question.content, shapeDeps),
        origin: answerOrigin(answer.source),
        answerLength: lengthBand(answer.content),
        questionLength: lengthBand(question.content),
        /* Sources are not stored on the row, so this is inferred from the
           answer carrying a citation marker. Named honestly rather than
           pretending to a field that does not exist. */
        hadSources: /\*\*[^*]+\.(pdf|docx?|csv|xlsx?|pptx?)\*\*/i.test(answer.content),
        admittedMiss,
        outcome,
      });
    }
  }

  return gists;
}
