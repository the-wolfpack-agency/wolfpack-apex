/**
 * "hi" is not a search.
 *
 * Five turns of a first conversation with the deployed assistant, from
 * somebody who had just arrived:
 *
 *   > hi
 *   < Here's what the brain has on this: BA101 Mobile Coach Rules.csv
 *     (chunk 5) > 01.new Condition: Response Regexp Value /no|don't...
 *   > I am new here, what now?
 *   < Here's what the brain has on this: NHomyk_NY W4.pdf (chunk 2)
 *     > g Allowance Certificate New York State...
 *   > thanks
 *   < Did you mean one of these? Tap a chip to run it.
 *
 * A greeting returned a spreadsheet of chatbot rules. "I am new here"
 * returned somebody's tax form. A thank-you was answered with a
 * disambiguation prompt.
 *
 * None of that is retrieval working badly. Retrieval worked exactly as
 * built: given any string it finds the nearest document, and for "hi"
 * there is no nearest document, only a least-far one. The failure is that
 * a greeting was ever handed to it.
 *
 * These turns carry no question. They are the opening and closing moves
 * of a conversation, and every product that people talk to has to answer
 * them, because they are the first thing anybody types and the last thing
 * they type before they stop.
 *
 * DELIBERATELY NARROW, for the reason every matcher in this codebase is:
 * a greeting detector that swallows "hi, can you find the Ackerman
 * invoice" would answer a real question with a wave. Only a bare social
 * turn qualifies. Anything carrying its own subject falls through to the
 * machinery built for subjects.
 */

/** The longest a bare social turn plausibly is. */
const MAX_SOCIAL_CHARS = 32;

/* Both of these are in the production backlog, filed as questions nobody
   could answer. They are not questions. */
const HOW_ARE_YOU_RE =
  /^(?:how\s+(?:are|r)\s+(?:you|u)|how'?s\s+it\s+going|how\s+are\s+things|what'?s\s+up|what\s+is\s+up|you\s+ok|you\s+alright)\b[\s,.!?]*$/i;

const GREETING_RE =
  /^(?:hi|hey|hello|yo|hiya|howdy|good\s+(?:morning|afternoon|evening)|morning|afternoon|evening)\b[\s,.!]*(?:there|all|team|again)?[\s,.!]*$/i;

const THANKS_RE =
  /^(?:thanks|thank\s+you|thx|ta|cheers|nice|great|perfect|lovely|brilliant|appreciate\s+it|much\s+appreciated)\b[\s,.!]*(?:so\s+much|a\s+lot|very\s+much|mate|then)?[\s,.!]*$/i;

const FAREWELL_RE =
  /^(?:bye|goodbye|see\s+you|see\s+ya|later|good\s+night|night|that'?s\s+all|that\s+is\s+all|nothing\s+else)\b[\s,.!]*$/i;

/** Somebody who has just arrived and is not asking for anything specific. */
const NEW_HERE_RE =
  /^(?:i(?:'m| am)\s+new(?:\s+here)?|new\s+here|first\s+time(?:\s+here)?|just\s+(?:got|started)\s+here)\b[\s,.!]*(?:what\s+now|what\s+next|where\s+do\s+i\s+start|help)?[\s,.!?]*$/i;

export type SocialKind = "greeting" | "thanks" | "farewell" | "new_here";

export function detectSocial(message: string): SocialKind | null {
  const m = message.trim();
  if (!m || m.length > MAX_SOCIAL_CHARS) return null;
  if (NEW_HERE_RE.test(m)) return "new_here";
  if (HOW_ARE_YOU_RE.test(m)) return "greeting";
  if (GREETING_RE.test(m)) return "greeting";
  if (THANKS_RE.test(m)) return "thanks";
  if (FAREWELL_RE.test(m)) return "farewell";
  return null;
}

/**
 * What to say back.
 *
 * A greeting is the one moment somebody is guaranteed to be paying
 * attention and has no question yet, so it is worth one line about what
 * to ask for. Not a menu: a menu at hello is a wall, and the capability
 * tool is one question away for anybody who wants the whole list.
 *
 * A thank-you gets acknowledged and nothing else. Answering it with
 * suggestions is how a product talks past somebody who was being polite.
 */
export function socialAnswer(kind: SocialKind, firstName?: string): string {
  const who = firstName ? ` ${firstName}` : "";
  switch (kind) {
    case "greeting":
      return (
        `Hello${who}. Ask me for something you would otherwise go and look up: what is on ` +
        `today, what came in overnight, where a piece of work stands. If you would rather see ` +
        `the whole list, ask what I can do.`
      );
    case "new_here":
      return (
        `Welcome${who}. The quickest way in is to ask for something you would otherwise ` +
        `go and fetch yourself: what is on your calendar today, what came in overnight, or ` +
        `what is waiting on you.\n\n` +
        `When you want more than one of those at once, ask what you can automate and I will ` +
        `show you the chains that do several in one command.`
      );
    case "thanks":
      return `Any time.`;
    case "farewell":
      return `Right you are. I will be here.`;
  }
}
