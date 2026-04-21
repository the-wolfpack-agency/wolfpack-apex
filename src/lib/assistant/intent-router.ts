/**
 * Token-free intent classifier for the Wolfpack Assistant.
 *
 * Maps a free-text question to one of a small set of deterministic
 * tool intents before any LLM is consulted. Keyword + regex rules
 * only — zero tokens.
 *
 * Per the zero-tokens-first invariant: codify the common question
 * patterns as tooling so the LLM is reserved for ambiguous cases,
 * not the headline ones.
 */

export type Intent =
  | "calendar_availability"  // "is Hoxsie busy this afternoon"
  | "calendar_schedule"      // "what's on Hoxsie's calendar tomorrow"
  | "brain_history"          // "how long was the Porsche engagement"
  | "mail_search"            // "find the email from James about Q2"
  | "financials_metric"      // "what's our MRR this quarter"
  | "goals_lookup"           // "what are our current OKRs"
  | "unknown";

export interface IntentMatch {
  intent: Intent;
  /** Extracted tokens the tool can use (name, timeframe, topic, etc.). */
  slots: Record<string, string>;
  /** 0-1 confidence. Rules fire with fixed confidences; lower values
   *  should fall back to RAG, not be treated as certain. */
  confidence: number;
}

const BUSY_RE = /\bis\s+([a-z][\w\s.'-]{0,40}?)\s+(busy|free|available)\b/i;
const SCHEDULE_RE = /\b(what'?s|whats|what is)\s+(on|in)\s+([a-z][\w\s.'-]{0,40}?)(?:'s|s')?\s+(calendar|schedule|agenda)\b/i;
const FINANCIAL_RE = /\b(mrr|arr|cash|revenue|net profit|unpaid|invoice|expense|burn|runway)\b/i;
const GOALS_RE = /\b(okr|okrs|north star|kr\b|key result|goals?)\b/i;
const MAIL_RE = /\bemail\b.*\b(from|about|regarding)\b|\bfind\s+(the\s+)?email\b/i;
const HISTORY_RE = /\b(how (?:long|many|much)|summary of|tell me about|history of|when was|how did)\b/i;

const TIME_HINTS: Record<string, string> = {
  "this morning": "morning_today",
  "this afternoon": "afternoon_today",
  "this evening": "evening_today",
  today: "today",
  tomorrow: "tomorrow",
  "this week": "this_week",
  "next week": "next_week",
  "this month": "this_month",
  "last month": "last_month",
  "this quarter": "this_quarter",
  "last quarter": "last_quarter",
  "this year": "this_year",
  "last year": "last_year",
};

function extractTimeframe(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const [phrase, token] of Object.entries(TIME_HINTS)) {
    if (lower.includes(phrase)) return token;
  }
  return undefined;
}

export function classifyIntent(text: string): IntentMatch {
  const q = text.trim();
  const slots: Record<string, string> = {};
  const tf = extractTimeframe(q);
  if (tf) slots.timeframe = tf;

  const busy = BUSY_RE.exec(q);
  if (busy) {
    slots.person = busy[1].trim();
    slots.mode = busy[2].toLowerCase();
    return { intent: "calendar_availability", slots, confidence: 0.9 };
  }

  const sched = SCHEDULE_RE.exec(q);
  if (sched) {
    slots.person = sched[3].trim();
    return { intent: "calendar_schedule", slots, confidence: 0.85 };
  }

  if (FINANCIAL_RE.test(q)) {
    return { intent: "financials_metric", slots, confidence: 0.7 };
  }

  if (GOALS_RE.test(q)) {
    return { intent: "goals_lookup", slots, confidence: 0.7 };
  }

  if (MAIL_RE.test(q)) {
    const from = /from\s+([a-z][\w\s.'-]{1,40}?)\b/i.exec(q);
    const about = /(about|regarding)\s+([^?.!]+)/i.exec(q);
    if (from) slots.from = from[1].trim();
    if (about) slots.topic = about[2].trim();
    return { intent: "mail_search", slots, confidence: 0.75 };
  }

  if (HISTORY_RE.test(q)) {
    // Grab a subject hint — the noun phrase after the pattern.
    const subjMatch = /\b(?:about|of|the)\s+([A-Z][\w\s-]{1,60})/.exec(q);
    if (subjMatch) slots.subject = subjMatch[1].trim();
    return { intent: "brain_history", slots, confidence: 0.6 };
  }

  return { intent: "unknown", slots, confidence: 0 };
}
