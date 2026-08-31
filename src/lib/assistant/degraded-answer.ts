/**
 * Telling somebody the truth about why there is no answer.
 *
 * THE DEFECT, MEASURED 2026-08-30. A document containing the answer is in the
 * corpus. Make the semantic store or the model provider unreachable, ask for
 * the payment terms, and the product replies:
 *
 *   "I don't have information on that yet. You can help me learn by adding it
 *    to the Knowledge Base..."
 *
 * Every word of that is false. It has the information, it did not look, and it
 * is inviting somebody to upload a second copy of a document it already holds.
 * In a client walkthrough it reads as the product having lost their documents,
 * which is the worst thing an outage can be mistaken for.
 *
 * THIS IS THE FAILURE CLASS THIS CODEBASE KEEPS FINDING: a store that can be
 * empty for two different reasons, and code that only knows one of them. It
 * has already been found in the triple write (Neo4j unconfigured read as
 * healthy), in the semantic half of the Brain (a bare `catch {}` hid a month
 * of zero semantic hits), and in universal search (`timedOut` set and never
 * read). Same shape, third and fourth instance.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not apologize at length, invent an
 * ETA, or name the vendor. A person wants three things: it is not their fault,
 * their data is still there, and whether to wait or do something else.
 */

/** Which part of the answer path did not run. */
export type DegradationKind =
  /** Vector search could not be reached or returned nothing usable. */
  | "semantic_search"
  /** No model could be reached: no provider configured, network, or throttle. */
  | "model"
  /** A connected system refused or timed out. */
  | "integration";

export interface Degradation {
  kind: DegradationKind;
  /** Short, for logs and events. Never shown verbatim to a person. */
  detail?: string;
}

/**
 * What a reader is told for each thing that broke.
 *
 * Written so the sentence is true whether or not the corpus has the answer,
 * because at the point this is used nobody knows: that is precisely what could
 * not be checked.
 */
const EXPLANATION: Record<DegradationKind, string> = {
  semantic_search:
    "I could not reach the search index just now, so I only looked at part of what you have.",
  model:
    "I could not reach the model that writes answers just now, so I could not put one together.",
  integration:
    "One of your connected systems did not respond just now, so I could not check it.",
};

/**
 * The reassurance, which is the part that actually matters.
 *
 * The old message's real damage was not that it failed, it was the suggestion
 * to go and add the document again. Somebody who believes their upload was
 * lost does the wrong thing twice: they duplicate what is there, and they stop
 * trusting the answers that ARE correct.
 */
const NOTHING_WAS_LOST =
  "Nothing has been lost, and nothing needs re-uploading: your documents are still there and I " +
  "simply could not read them this time.";

export interface DegradedAnswer {
  text: string;
  kinds: DegradationKind[];
}

/**
 * Build the honest version of "I have no answer", or return null when the
 * system was healthy and the plain empty answer is the true one.
 *
 * Returning null on a healthy turn is the important half. "I have nothing on
 * that" is a perfectly good answer when it is TRUE, and dressing every empty
 * result up as an outage would be the same defect pointed the other way.
 */
export function degradedAnswer(degradations: Degradation[]): DegradedAnswer | null {
  if (degradations.length === 0) return null;

  /* Deduplicated and ordered, so two failures of one kind read as one problem
     and the sentence is identical every time the same thing breaks. A person
     comparing today's outage to last week's should see the same words. */
  const kinds = (["semantic_search", "model", "integration"] as const).filter((k) =>
    degradations.some((d) => d.kind === k),
  );

  const sentences = kinds.map((k) => EXPLANATION[k]);

  return {
    kinds: [...kinds],
    text: `${sentences.join(" ")} ${NOTHING_WAS_LOST} This is a problem on our side, not with your question. Please try again in a minute, and if it keeps happening tell your Wolfpack contact.`,
  };
}

/**
 * Collects what broke during one turn.
 *
 * Per-turn instance rather than module state, because two people asking
 * questions at the same time must not inherit each other's outages.
 */
export class TurnDegradation {
  private readonly seen: Degradation[] = [];

  record(kind: DegradationKind, detail?: string): void {
    this.seen.push({ kind, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
  }

  get all(): Degradation[] {
    return [...this.seen];
  }

  get any(): boolean {
    return this.seen.length > 0;
  }

  /** Null when healthy, so callers can keep their existing empty-answer text. */
  answer(): DegradedAnswer | null {
    return degradedAnswer(this.seen);
  }
}
