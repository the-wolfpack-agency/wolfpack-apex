/**
 * Questions about records we cannot reach.
 *
 * Production, thirty days: 22,651 intents classified, 11,367 answered by
 * a deterministic tool, and 802 that reached a model after a tool
 * declined. Of a corpus of ten prompts written the way somebody at a
 * dealership types them, seven matched no tool at all.
 *
 * Those seven do not fail. They go to a model, which answers fluently
 * about warranty claims it has never seen, and the answer is indis-
 * tinguishable in tone from the ones backed by the client's own data.
 * That is the worst outcome available: it costs tokens AND it teaches
 * somebody to trust a sentence nothing checked.
 *
 * A deterministic "nothing connected here holds that" is better on every
 * axis. It is honest, it names what to connect, it costs nothing, and it
 * is the same answer every time.
 *
 * WHY THIS IS NARROW. Intercepting a question the model could genuinely
 * answer would be the trespass failure again, and worse, because this
 * refuses rather than guesses. So it fires only when all three hold:
 *
 *   1. The question names a record type from a domain no tool covers.
 *   2. It is a LOOKUP, asking which/what/how many/show me, rather than
 *      asking for advice, a draft, or an explanation. "How do I appeal a
 *      denied claim" is a question a model should answer; "which claims
 *      were denied" is a question about their data.
 *   3. Nothing is connected that could serve it.
 *
 * Advice, drafting and general knowledge all fall straight through.
 */

/** Record types no tool reaches today, with what would serve them. */
const UNREACHABLE_DOMAINS: Array<{
  /** Word-boundary matched, so "arrears" never counts as "arr". */
  nouns: string[];
  label: string;
  /** The system a client would connect to make this answerable. */
  source: string;
}> = [
  {
    nouns: ["warranty claim", "warranty claims", "claim status", "claim submission"],
    label: "warranty claims",
    source: "your warranty system",
  },
  {
    nouns: ["repair order", "repair orders", "ro number", "work order", "work orders"],
    label: "repair orders",
    source: "your DMS",
  },
  {
    nouns: ["parts order", "parts orders", "parts inventory", "back order", "backorder"],
    label: "parts and ordering",
    source: "your parts system",
  },
  {
    nouns: [
      "technician note", "technician notes", "service history",
      "service record", "service records",
      /* "the repair order" reads as a record in a way "repair" alone
         does not, which is why the noun carries its own word. */
      "on the repair order", "in the repair order",
    ],
    label: "service records",
    source: "your DMS",
  },
];

/** Asking for records, rather than for advice or a draft. */
const LOOKUP_RE =
  /^\s*(?:which|what did|what does|what is the status|what|how many|how much|show(?:\s+me)?|list|find|pull(?:\s+up)?|are there|is there|any|who|where (?:is|are))\b/i;

/**
 * Asking how to do something, or for words to use.
 *
 * These are questions a model should answer and this must never take
 * them. "How do I submit a warranty claim" is training; "which warranty
 * claims are open" is data.
 */
const ADVICE_RE =
  /\b(?:how do i|how should i|how can i|what should i say|help me|explain|why (?:do|does|is|are|was|were))\b|\b(?:draft|write|compose)\s+(?:me\s+)?(?:a|an|the)\b/i;

export interface NotConnected {
  label: string;
  source: string;
  answer: string;
}

export function detectUnreachable(message: string): NotConnected | null {
  const m = message.trim();
  if (!m) return null;
  if (ADVICE_RE.test(m)) return null;
  if (!LOOKUP_RE.test(m)) return null;

  const lower = m.toLowerCase();
  for (const domain of UNREACHABLE_DOMAINS) {
    for (const noun of domain.nouns) {
      const re = new RegExp(`\\b${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      if (!re.test(lower)) continue;
      return {
        label: domain.label,
        source: domain.source,
        /* Says the limit, names the fix, and offers what IS reachable.
           A refusal that stops at "I can't" is a dead end; a client
           reading this knows what to do next. */
        answer:
          `I cannot answer that yet: nothing connected to me holds your ${domain.label}. ` +
          `Connect ${domain.source} and this becomes a question I can answer from your own ` +
          `records rather than a guess.\n\n` +
          `In the meantime I can work with your mail, calendar, tasks, documents and any CRM ` +
          `you have connected. Ask me what I can do to see the full list.`,
      };
    }
  }
  return null;
}
