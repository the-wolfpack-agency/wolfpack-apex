/**
 * Somebody asked about their own week and Microsoft is not connected.
 *
 * WHAT THIS REPLACES. "What did I miss this week?" reached no tool, so it went
 * to the model, which answered in 5,189ms:
 *
 *   "I cannot access your personal information like your calendar, tasks, or
 *    emails. If you provide more context or specify what you're looking for,
 *    I can help summarize notable events or updates from this week."
 *
 * Measured against the live deployment 2026-08-29. Three things wrong with it.
 *
 * It READS AS A POLICY REFUSAL. "I cannot access your personal information"
 * sounds like we have decided not to look, when the truth is that nobody has
 * finished connecting an account. Those need opposite reactions from the
 * reader: one is a dead end, the other is a two-minute setup step.
 *
 * It CONTRADICTS the answer next door. "What are my tasks?" returns "Microsoft
 * is not connected yet, so I cannot read your tasks. Connect it in Settings."
 * Same cause, same user, same minute, two different explanations, and only one
 * of them is true.
 *
 * It COST A MODEL CALL AND FIVE SECONDS to produce something the system already
 * knew. Same waste as paying a model to phrase "no results found": the
 * deterministic layer had established the fact and we bought a paraphrase of it.
 *
 * NARROW ON PURPOSE. It fires only when the question is about the person's OWN
 * Microsoft-backed data and there is no connection to read it from. "What did
 * the SOW say" is not personal data. "What did I miss" asked by somebody whose
 * account IS connected goes to the model as before, because then the model has
 * something to work with.
 */

/**
 * The person's own Graph-backed world: their week, their inbox, their day.
 *
 * Requires a first-person marker AND a Microsoft-backed noun, so "what did the
 * team miss" and "what is on the shared calendar" are untouched. A question
 * about somebody else's week is a different question with a different answer.
 */
/**
 * "How do I use Calendar" is a question about the PRODUCT, not about a week.
 *
 * Caught by the existing page-facts tests on the first run of this gate: the
 * "I" in "how do I use X" is not possessive, it is somebody asking how to
 * operate a screen, and page facts answers those at zero tokens. Swallowing
 * them here would replace a working feature with a setup notice.
 */
const IS_A_HOW_TO = /^\s*(?:how\s+(?:do|can|would)\s+i\b|how\s+to\b|where\s+(?:do|can)\s+i\s+(?:find|see|get)\b|what\s+(?:is|are)\s+the\s+\w+\s+(?:page|tab|screen)\b)/i;

const ASKS_ABOUT_MY_GRAPH_DATA =
  /\b(?:my|i|me|mine)\b[^.?!]{0,60}\b(?:calendar|inbox|email|e-?mails?|mail|tasks?|meetings?|schedule|day|week|agenda|miss(?:ed|ing)?)\b|\bwhat did i miss\b|\bcatch me up\b|\bwhat'?s on (?:my|the) (?:calendar|schedule|plate)\b/i;

/** What every surface says, so the reader is never told two different stories. */
export const MICROSOFT_NOT_CONNECTED =
  "Microsoft is not connected yet, so I cannot read your calendar, mail or tasks. " +
  "Connect it in Settings and I will be able to answer this.";

export interface PersonalDataCheck {
  /** True when the question is about the asker's own Graph-backed data. */
  asksAboutOwnGraphData: boolean;
  /** The answer to give, when one should be given without a model. */
  answer?: string;
}

/**
 * Decide whether this question can be answered deterministically right now.
 *
 * `connected` is passed in rather than looked up, so this stays pure and the
 * caller keeps the one place that knows how to ask Microsoft anything.
 */
export function checkPersonalDataQuestion(
  message: string,
  connected: boolean,
): PersonalDataCheck {
  const text = (message ?? "").trim();
  if (!text) return { asksAboutOwnGraphData: false };

  /* Checked first: a how-to mentions the same nouns and means the opposite. */
  if (IS_A_HOW_TO.test(text)) return { asksAboutOwnGraphData: false };

  const asks = ASKS_ABOUT_MY_GRAPH_DATA.test(text);
  if (!asks) return { asksAboutOwnGraphData: false };
  /* Connected: the model has real data to work from, so this stays out of the
     way entirely. The gate exists for the case where no answer is possible. */
  if (connected) return { asksAboutOwnGraphData: true };

  return { asksAboutOwnGraphData: true, answer: MICROSOFT_NOT_CONNECTED };
}
