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

import { classifyIntent, SELF_TOKEN, type IntentMatch } from "@/lib/assistant/intent-router";
import { runCalendarAvailability } from "@/lib/assistant/tools/calendar-availability";
import { runBrainHistory } from "@/lib/assistant/tools/brain-history";
import { runMailSearch } from "@/lib/assistant/tools/mail-search";
import { runGoalsLookup } from "@/lib/assistant/tools/goals-lookup";
import { runFinancialsMetric } from "@/lib/assistant/tools/financials-metric";
import { runMeetingsOnDate } from "@/lib/assistant/tools/meetings-on-date";
import { resolveTimeframe } from "@/lib/assistant/timeframe";

export interface ToolAnswer {
  intent: IntentMatch["intent"];
  answer: string;
  /** Structured payload the UI can render alongside the answer. */
  data: unknown;
  source: "tool";
}

export interface ToolContext {
  /** Caller's MS Graph userId (their email in practice) — needed by
   *  mail_search since it reads the caller's mailbox. */
  userId: string;
  /** Caller's role — used to gate financials to ceo/cto only. */
  userRole: string;
  /** Caller's display name — used by first-person calendar queries so
   *  the answer reads "You have 2 meetings…" instead of the email. */
  userDisplayName?: string;
  nowMs?: number;
  /** IANA zone from the browser (e.g. "America/New_York"). Used when
   *  formatting server-rendered times so the answer reads in the
   *  caller's local zone, not the server's UTC. */
  timeZone?: string;
}

export async function tryToolAnswer(
  question: string,
  ctx: ToolContext,
): Promise<ToolAnswer | null> {
  const match = classifyIntent(question);

  if (match.intent === "calendar_availability" || match.intent === "calendar_schedule") {
    const person = match.slots.person;
    if (!person) return null;
    const selfUser =
      person === SELF_TOKEN
        ? { userId: ctx.userId, displayName: ctx.userDisplayName || ctx.userId }
        : undefined;
    const result = await runCalendarAvailability({
      personName: person,
      timeframeToken: match.slots.timeframe,
      nowMs: ctx.nowMs,
      selfUser,
      timeZone: ctx.timeZone,
    });
    if (!result) return null;
    return { intent: match.intent, answer: result.answer, data: result, source: "tool" };
  }

  if (match.intent === "meetings_on_date") {
    const result = await runMeetingsOnDate({
      question,
      nowMs: ctx.nowMs,
      userId: ctx.userId,
    });
    if (!result) return null;
    return { intent: match.intent, answer: result.answer, data: result, source: "tool" };
  }

  if (match.intent === "goals_lookup") {
    const result = await runGoalsLookup();
    if (!result) return null;
    return { intent: match.intent, answer: result.answer, data: result, source: "tool" };
  }

  if (match.intent === "financials_metric") {
    const result = await runFinancialsMetric({
      question,
      timeframeToken: match.slots.timeframe,
      nowMs: ctx.nowMs,
      userRole: ctx.userRole,
    });
    if (!result) return null;
    return { intent: match.intent, answer: result.answer, data: result, source: "tool" };
  }

  if (match.intent === "mail_search") {
    const result = await runMailSearch({
      userId: ctx.userId,
      from: match.slots.from,
      topic: match.slots.topic,
    });
    if (!result) return null;
    return { intent: match.intent, answer: result.answer, data: result, source: "tool" };
  }

  if (match.intent === "brain_history") {
    const tfLabel = match.slots.timeframe
      ? resolveTimeframe(match.slots.timeframe, ctx.nowMs).label
      : undefined;
    const result = await runBrainHistory({
      subject: match.slots.subject ?? question,
      timeframeLabel: tfLabel,
    });
    if (!result) return null;
    return { intent: match.intent, answer: result.answer, data: result, source: "tool" };
  }

  return null;
}

export { classifyIntent };
