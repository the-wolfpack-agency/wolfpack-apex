/**
 * Turning a logged query into something safe to put on a dashboard.
 *
 * THE DEFECT THIS FIXES. The gap panel rendered every query verbatim. On our
 * own data that published a colleague's name typed into a search box, a candid
 * remark about the product, and a 1,400-character passage somebody had pasted
 * in, repeated fourteen times, which alone was longer than the rest of the
 * page. All of it true, none of it anybody's business, and the paste pushed
 * every section below it off the screen.
 *
 * THE MISREADING UNDERNEATH IT. A gap list's unit is the TOPIC, not the
 * transcript. A reader needs to know that people ask about warranty claims and
 * nothing is connected for it. The exact words one person typed at 4pm add
 * nothing to that and cost a great deal, so rendering them was showing the
 * wrong thing and leaking at the same time.
 *
 * FOUR THINGS ARRIVE IN THAT LOG AND ONLY ONE IS A QUESTION.
 *
 *   A question       shown, shortened if it runs long.
 *   A paste          its opening clause, which is the topic. The body is what
 *                    somebody had on their clipboard and never a gap.
 *   A person's name  shown as the fact that somebody searched for a person.
 *                    The signal is that a directory is not connected; the name
 *                    is not part of the signal.
 *   A remark         withheld. "This platform still sucks" has no answer to be
 *                    missing, so it was never a gap, and putting it on a
 *                    client's dashboard reads as a complaint we forwarded.
 *
 * WHAT IT CANNOT DO, SAID PLAINLY. Names are masked by matching the directory,
 * so it catches the people the workspace knows about and misses anyone else: a
 * customer, a supplier, somebody typed with a misspelling. That is a real
 * limit, not a rounding error, which is why length and shape do most of the
 * work here and the mask is the last line rather than the first.
 */

import { redactText } from "@/lib/ai/redaction";
import { maskKnownNames } from "@/lib/privacy/mask-names";

/** Longer than this and it is a passage somebody pasted, not a question. */
export const MAX_CHARS = 110;

/** Why the original was not shown as typed. */
export type Withheld = "paste" | "name" | "remark";

export interface DisplayQuestion {
  /** Safe to render. Never longer than MAX_CHARS. */
  text: string;
  /** Absent when the question is shown as it was asked. */
  withheld?: Withheld;
}

/* Openers that make something a question or a request, which is the only thing
   a gap list is about. Deliberately a list rather than a cleverness: a query
   wrongly judged not-a-question disappears from the report and is never asked
   again by it, so the failure is silent and permanent. */
const ASKS =
  /^(?:who|what|when|where|which|why|how|is|are|was|were|do|does|did|can|could|should|would|will|may|might|has|have|had|any|list|show|find|tell|give|explain|summari[sz]e|analy[sz]e|compare|draft|write|describe|outline|search|look up|pull|get me|remind|collect|create|make|add|assign|move|send|delete|remove|schedule|book|set up|turn on|turn off|rename|archive|file|sort|organi[sz]e|upload|export|share|invite|synthesi[sz]e|generate)\b/i;

/** Leading bullets, dashes and quotes, so an opener is judged on its words. */
const stripLead = (s: string) => s.replace(/^[\s\-*•>"'`(\[]+/, "");

/**
 * A question, or something a person said.
 *
 * A question mark settles it. Otherwise the query has to open like a question
 * or an instruction. Everything else is a statement, and a statement has no
 * answer that could have been missing.
 */
export function isAnswerable(raw: string): boolean {
  const q = stripLead(raw).trim();
  if (!q) return false;
  if (q.includes("?")) return true;
  return ASKS.test(q);
}

/* Two or three plain words, no digits, no punctuation. "john paul smith" and
   "dana ruiz" fit; "warranty claim process" would too, which is why this is
   checked only AFTER the answerable test has already rejected it: a phrase
   that opens like a question is never treated as a name. */
const BARE_WORDS = /^[a-z][a-z'’.-]*(?: [a-z][a-z'’.-]*){1,2}$/i;

/**
 * Cut to a whole word, at a sentence end where there is one nearby.
 *
 * A paste usually opens with the actual instruction and then carries the
 * material, so the first sentence is the part worth keeping.
 */
function shorten(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const head = text.slice(0, MAX_CHARS);
  const stop = head.lastIndexOf(". ");
  if (stop > 40) return `${head.slice(0, stop)}.`;
  const space = head.lastIndexOf(" ");
  return `${(space > 40 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * What a reader should see instead of the query, or null to show nothing.
 *
 * `known` is lowercase full names and first names from the workspace
 * directory. Passing an empty list is supported and simply means no masking.
 */
export function forDisplay(raw: string, known: readonly string[] = []): DisplayQuestion | null {
  /* Cards, keys and account numbers first, before any decision is made about
     the text, so nothing downstream can reintroduce one. */
  const cleaned = redactText(stripLead(raw ?? "").trim()).text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  if (!isAnswerable(cleaned)) {
    /* Somebody searched for a person. The gap is real and worth showing: a
       directory is not connected. The name is not the gap. */
    if (BARE_WORDS.test(cleaned)) return { text: "a person's name", withheld: "name" };
    /* A statement. No answer was missing, so it was never a gap. */
    return null;
  }

  const masked = maskKnownNames(cleaned, known);
  const long = masked.text.length > MAX_CHARS;
  const text = shorten(masked.text);

  /* Length is reported ahead of masking, because a truncated line explains
     itself and a name that was swapped out does not. */
  if (long) return { text, withheld: "paste" };
  if (masked.masked) return { text, withheld: "name" };
  return { text };
}
