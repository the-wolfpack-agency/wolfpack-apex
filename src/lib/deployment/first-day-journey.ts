/**
 * The first day, as a client's employee would actually spend it.
 *
 * NOTHING HERE MAY DEPEND ON OUR DATA.
 *
 * The first version of this file asked "what are the payment terms in our
 * SOW?", which is a real question with a real answer in OUR corpus and no
 * answer at all in anybody else's. Pointed at a client instance it would have
 * failed on their first day and reported the product broken, when the truth
 * was that they simply do not have our documents.
 *
 * A journey that only passes against the corpus it was written for measures
 * nothing. So the steps are split:
 *
 *   - UNIVERSAL steps work on any deployment, because they test behavior
 *     rather than content: does it refuse cleanly when a connector is missing,
 *     does it explain itself, does it invent an answer when none exists.
 *   - CORPUS steps need one fact from whoever owns the deployment, supplied as
 *     config. Without them the journey still runs and says which coverage it
 *     did not have, rather than passing quietly on a smaller check.
 *
 * WHAT TO ASK FOR WHEN STANDING UP A CLIENT
 *
 * Two questions whose answers they already know, phrased the way the product
 * actually answers well. Measured 2026-08-29 against production:
 *
 *   WORKS   "what are the payment terms in our SOW?"      -> answer + citation
 *   WORKS   "when is the final payment due in our SOW?"   -> direct answer
 *   COUNT   "what do our documents say about onboarding"  -> "Found 4 results"
 *   COUNT   "summarize the onboarding document"           -> "Found 3 results"
 *
 * A direct factual question gets a synthesised answer. Anything phrased as a
 * document command routes to search and returns a count, so the config asks
 * for questions, not commands.
 */
import type { JourneyStep } from "./journey";
import { MODULE_CAPABILITIES, type ModuleAction } from "@/lib/modules/capabilities";

/** One fact the deployment's owner knows the answer to. */
export interface CorpusProbe {
  /** Asked verbatim. A QUESTION, not a command: "what is our refund window?" */
  ask: string;
  /** Optional: a distinctive string the answer should contain. */
  expectContains?: string;
}

export interface JourneyConfig {
  /**
   * Questions answerable from THIS deployment's documents.
   *
   * Empty is allowed and honest: the journey then reports that document
   * retrieval was not covered, rather than passing on the universal steps
   * alone and implying the corpus was checked.
   */
  corpusProbes?: CorpusProbe[];
}

/**
 * Steps that hold on ANY deployment, because none of them needs our data.
 *
 * Each tests a behavior that is either right or wrong regardless of what is in
 * the corpus, which is what makes them portable.
 */
export const UNIVERSAL_STEPS: JourneyStep[] = [
  {
    id: "capability",
    ask: "what can you do?",
    /* A tour IS the right answer here, and it is the only step where that is
       true. Keeping it in proves the classifier is not simply flagging every
       long answer. */
    expect: ["substantive", "product_tour"],
    budgetMs: 6_000,
    because: "Everyone asks this first. It must not read as an error.",
  },
  {
    id: "nonsense",
    ask: "what is the quarterly revenue of the moon department",
    /* Confabulation is the failure that destroys trust fastest and is invisible
       unless something asks a question with no possible answer. Portable by
       construction: no deployment has a moon department. */
    expect: ["empty", "needs_setup"],
    budgetMs: 10_000,
    because: "Must not invent an answer for something that cannot exist.",
  },
  {
    id: "calendar",
    ask: "what's on my calendar today?",
    /* A clean refusal is a PASS. On a deployment with no Microsoft connection
       "not connected, connect it in Settings" is the correct answer, and
       scoring it as failure would fail every instance on day one. */
    expect: ["substantive", "needs_setup", "empty"],
    budgetMs: 10_000,
    because: "Graph-backed. Refusing cleanly when unconnected is correct.",
  },
  {
    id: "document-search-responds",
    ask: "find anything about invoices",
    /* Deliberately NOT asserting a hit. A new deployment may hold nothing
       about invoices and that is fine; what must not happen is a leaked error
       or silence. This checks the retrieval path is alive, not what is in it. */
    expect: ["substantive", "empty", "needs_setup"],
    budgetMs: 8_000,
    because: "Proves the document path responds at all, without assuming content.",
  },
];

/**
 * Build the journey for a specific deployment.
 *
 * Universal steps always run. Corpus steps appear only when somebody supplied
 * a question their own documents can answer.
 */
/**
 * Turn every module's SUPPORTED actions into steps.
 *
 * THIS IS WHY THE CONTRACT IS WORTH THE STRUCTURE. Declaring DMS or CRM
 * capabilities adds their verification here automatically, so a module cannot
 * ship claiming an action nobody ever drove against a real deployment. Written
 * by hand instead, each module's coverage would depend on somebody remembering,
 * and documents is the evidence for how that goes.
 *
 * Only `supported` actions become steps. An action declared as routing
 * elsewhere is a known gap, and failing the journey on a gap already written
 * down turns the report into noise.
 *
 * The expectation comes from the DECLARED shape, so a module claiming a
 * synthesised answer and returning a list fails here rather than in front of a
 * client. `empty` is allowed alongside: a fresh deployment holds nothing, and
 * that is not the module being broken.
 */
function stepForAction(a: ModuleAction): JourneyStep {
  return {
    id: `module-${a.id}`,
    ask: a.example,
    expect: a.returns === "synthesised" ? ["substantive", "empty"] : ["substantive", "empty", "needs_setup"],
    budgetMs: 10_000,
    because: `${a.verb}: ${a.because}`,
  };
}

export function moduleSteps(): JourneyStep[] {
  return MODULE_CAPABILITIES.flatMap((m) =>
    m.actions.filter((a) => a.status === "supported").map(stepForAction),
  );
}

export function buildJourney(config: JourneyConfig = {}): JourneyStep[] {
  const corpus = (config.corpusProbes ?? []).map(
    (probe, i): JourneyStep => ({
      id: `corpus-${i + 1}`,
      ask: probe.ask,
      /* Empty is NOT acceptable here. This is a question whose answer the
         deployment's owner says exists, so finding nothing is a real failure
         rather than an honest miss. */
      expect: ["substantive"],
      budgetMs: 10_000,
      because: "A question this deployment's own documents are known to answer.",
    }),
  );
  /* Universal behavior, then every module's declared capability, then the
     deployment's own corpus questions. */
  return [...UNIVERSAL_STEPS, ...moduleSteps(), ...corpus];
}

/**
 * Our own probes, for running against our instance.
 *
 * Kept OUT of the universal list on purpose: they are configuration, not part
 * of the product's definition of working.
 */
export const WOLFPACK_PROBES: CorpusProbe[] = [
  { ask: "what are the payment terms in our SOW?" },
  { ask: "when is the final payment due in our SOW?" },
];
