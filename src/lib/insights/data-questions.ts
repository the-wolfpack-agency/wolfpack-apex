/**
 * Questions the product asks of a client's own data, on their behalf.
 *
 * WHAT THIS IS FOR. A new client connects SharePoint and sees a search box.
 * That is a tool, not an answer, and it puts the burden of knowing what to ask
 * on the person who has just arrived. The measured cost of that is on the
 * pilot dashboard: 87 dead-end answers in sixty days, and a repeated-failure
 * list led by somebody typing "find coaching calls spreasheet" 36 times.
 *
 * So this is a curated set of questions worth asking of any document corpus,
 * run for the reader, with the answers presented as findings. It is the
 * difference between "here is a search box" and "here is what we found in your
 * systems".
 *
 * RUN AS THE READER, ALWAYS. Every question goes through the same chat() a
 * person uses, with THEIR user id, so retrieval is scoped by their own
 * permissions and SharePoint applies its own access rules. An insight panel
 * that showed one person a document another had locked would be a disclosure,
 * and the only reliable way to avoid it is never to have privileged access in
 * the first place.
 *
 * WHY THESE QUESTIONS. Each earns its place by being answerable from metadata
 * and retrieval the client already has, on day one, with nothing ingested and
 * nothing configured. A question needing a connector they have not set up
 * produces a dead end, which is the failure the starter prompts already made
 * three times over.
 *
 * WHAT IT REFUSES TO DO. It does not invent a narrative. Each finding is the
 * assistant's own answer with its own citations, and a question that comes back
 * empty is REPORTED as empty rather than dropped. A panel that silently hides
 * what it could not answer is how a client learns to distrust the ones it did.
 */

export interface DataQuestion {
  /** Stable id, so a finding can be tracked across runs. */
  id: string;
  /** What gets asked, in the words a person would use. */
  ask: string;
  /** The heading this finding appears under. */
  title: string;
  /** Why this is worth asking, shown to whoever reads the panel. */
  why: string;
}

/**
 * The starting set.
 *
 * Deliberately small. Six questions a reader will actually read beats twenty
 * they will scroll past, and every one of these costs a real retrieval against
 * their systems.
 */
export const DATA_QUESTIONS: DataQuestion[] = [
  {
    id: "corpus_reach",
    ask: "what can you do",
    title: "What is connected",
    why: "What this workspace can answer from today, filtered to what your role may actually run.",
  },
  {
    id: "recent_documents",
    ask: "what documents do we have about onboarding",
    title: "Onboarding material",
    why: "Onboarding is the corpus every organization has and the one new joiners look for first.",
  },
  {
    id: "agreements",
    ask: "what does the sow say about payment terms",
    title: "Commercial terms",
    why: "The question a finance or delivery lead asks first, and the one a document library exists to answer.",
  },
  {
    id: "policy",
    ask: "what is our policy on pto",
    title: "Policy",
    why: "Policy questions are the highest-volume internal request in most organizations and the cheapest to deflect.",
  },
  {
    id: "team_shape",
    ask: "who is on the team",
    title: "Who is here",
    why: "Read from the roster rather than from documents, so it names colleagues rather than whoever a file happens to mention.",
  },
  {
    id: "this_week",
    ask: "what is on my calendar this week",
    title: "The week ahead",
    why: "Read live from the calendar. Nothing is synced or stored to answer it.",
  },
];

export interface Finding {
  id: string;
  title: string;
  why: string;
  /** What was asked, so a reader can re-run it themselves. */
  ask: string;
  /** The assistant's own answer. */
  answer: string;
  /** Where the answer came from: a tool, a cache, or a model. */
  source: string;
  /**
   * True when the answer told the reader nothing.
   *
   * Reported rather than hidden. A panel that silently drops what it could not
   * answer teaches a client to distrust the findings it did show, and the
   * empty ones are the most useful thing on the page: they are the gaps worth
   * connecting something to.
   */
  empty: boolean;
  tookMs: number;
}

/** Phrases the product produces when it has nothing, so a finding can say so. */
const EMPTY_ANSWER =
  /(no results found|don'?t have a confident answer|not connected yet|have not been synced|i don'?t have any verified facts|no one on the roster)/i;

export function isEmptyAnswer(answer: string): boolean {
  if (!answer.trim()) return true;
  return EMPTY_ANSWER.test(answer);
}
