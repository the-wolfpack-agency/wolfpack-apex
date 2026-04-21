/**
 * Assistant orchestrator — routes a free-text question through the
 * token-free tool pipeline before any LLM is touched.
 *
 * Flow:
 *   1. classifyIntent (deterministic regex/keyword router)
 *   2. Dispatch to the matching tool if we got one
 *   3. If tool returns null OR intent is "unknown", the caller falls
 *      back to RAG (which itself only calls the LLM on low-confidence
 *      retrieval).
 *
 * Everything the orchestrator does is zero-token — the LLM is only
 * invoked downstream of `tryToolAnswer() === null`.
 */

import { classifyIntent, type IntentMatch } from "@/lib/assistant/intent-router";
import { runCalendarAvailability } from "@/lib/assistant/tools/calendar-availability";

export interface ToolAnswer {
  intent: IntentMatch["intent"];
  answer: string;
  /** Structured payload the UI can render alongside the answer. */
  data: unknown;
  source: "tool";
}

export async function tryToolAnswer(
  question: string,
  opts: { nowMs?: number } = {},
): Promise<ToolAnswer | null> {
  const match = classifyIntent(question);

  if (match.intent === "calendar_availability" || match.intent === "calendar_schedule") {
    const person = match.slots.person;
    if (!person) return null;
    const result = await runCalendarAvailability({
      personName: person,
      timeframeToken: match.slots.timeframe,
      nowMs: opts.nowMs,
    });
    if (!result) return null;
    return {
      intent: match.intent,
      answer: result.answer,
      data: result,
      source: "tool",
    };
  }

  // Other intents (mail_search, financials_metric, goals_lookup,
  // brain_history) get wired in follow-up commits — returning null
  // means the caller falls through to the existing RAG path.
  return null;
}

export { classifyIntent };
