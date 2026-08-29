/**
 * What each module can actually do, declared once and checked against reality.
 *
 * WHY THIS EXISTS, AND WHY NOW
 *
 * Measured against the live deployment 2026-08-29, the documents module:
 *
 *   ASK      "what are the payment terms in our SOW?"    -> answer + citation
 *   FIND     "what documents do we have about onboarding" -> a browsable list
 *   SUMMARISE "summarize the onboarding document"         -> a browsable list
 *
 * Two of those are right. The third is a verb the interface invites and the
 * engine does not honour, so somebody asks for a summary and receives a
 * filing cabinet. Nothing was broken; the UI simply offered something the
 * engine never agreed to.
 *
 * That gap is cheap to patch once for documents. The reason it needs a
 * structure instead is that DMS, CRM and every module after will each arrive
 * with the same problem: a set of verbs people will naturally try, and an
 * engine honouring some subset. Solved per module, it is solved three
 * different ways and drifts three different directions. The current state of
 * documents IS what that drift looks like after one module.
 *
 * SO THE CONTRACT IS DATA, NOT UI
 *
 *   1. Each module declares its actions and what each RETURNS.
 *   2. The interface is generated from the declaration, so it can only ever
 *      offer what the engine honours.
 *   3. A verb the engine does not honour is declared as routing somewhere,
 *      rather than quietly behaving like something else.
 *   4. A test asserts the declaration is honest, so "we support summarise"
 *      cannot be written down while summarise returns a list.
 *
 * The fourth point is the one that matters. A contract nobody verifies becomes
 * marketing inside a week, and this file would then be a second place where
 * the truth is not.
 *
 * Sources come from PROMPT_REQUIREMENTS rather than a new list, because a set
 * of names maintained in two places drifts in one.
 */
import { PROMPT_REQUIREMENTS, type PromptRequirement } from "@/lib/assistant/welcome-prompts";

/** What comes back, which is the thing a person actually cares about. */
export type AnswerShape =
  /** Prose answering the question, with its source. What the product sells. */
  | "synthesised"
  /** A browsable set of results. Right for "find", wrong for "summarise". */
  | "list"
  /** One record, rendered. A vehicle, a contact, an invoice. */
  | "record"
  /** Something changed. Creating, updating, sending. */
  | "action";

export type ActionStatus =
  /** Verified working. Belongs in the interface. */
  | "supported"
  /** People will say it and the engine does something ELSE. Declared so the
   *  interface can set expectations rather than let them be discovered. */
  | "routes_elsewhere"
  /** Known gap, not yet built. Never offered in the interface. */
  | "planned";

export interface ModuleAction {
  /** Stable id. Results and analytics join on it across modules. */
  id: string;
  /** The verb in the words a person uses, not ours. */
  verb: string;
  /** A phrasing measured to produce `returns`. Shown as the example. */
  example: string;
  returns: AnswerShape;
  status: ActionStatus;
  /**
   * For `routes_elsewhere`: the action id it actually behaves like.
   *
   * This is the honest record of a gap. "Summarise behaves like find" is a
   * sentence somebody can act on; a summarise button that returns a list is
   * a bug report waiting to be written by a client.
   */
  behavesLike?: string;
  /** Why somebody would do this, for the interface to explain itself. */
  because: string;
}

export interface ModuleCapability {
  /** Reuses the existing source names. */
  source: PromptRequirement;
  /** What a person calls this module. */
  label: string;
  actions: ModuleAction[];
}

/**
 * DOCUMENTS — the Phase 1 module, and the only one measured end to end.
 *
 * Every `returns` below was observed against the live deployment on
 * 2026-08-29, not inferred from the code.
 */
const DOCUMENTS: ModuleCapability = {
  source: "documents",
  label: "Documents",
  actions: [
    {
      id: "documents.ask",
      verb: "ask a question",
      example: "what does our policy say about time off?",
      returns: "synthesised",
      status: "supported",
      because: "The answer, in prose, with the document it came from.",
    },
    {
      id: "documents.find",
      verb: "find",
      example: "what documents do we have about onboarding?",
      returns: "list",
      status: "supported",
      because: "See everything on a topic before picking one.",
    },
    {
      id: "documents.summarise",
      verb: "summarise",
      example: "summarize the onboarding document",
      /* DECLARED AS IT BEHAVES, NOT AS IT READS. Measured returning a list:
         "summarize the onboarding document" -> "Found 3 results" plus result
         rows. Recording it as supported would make this file the second place
         the truth is not. */
      returns: "list",
      status: "routes_elsewhere",
      behavesLike: "documents.find",
      because: "People ask for this constantly. Today it returns the matches instead.",
    },
  ],
};

/**
 * The registry. DMS and CRM join here as their modules land.
 *
 * A module with no verified actions belongs in `planned`, not absent: a gap
 * that is written down gets built, and one that is merely missing gets
 * discovered by a client.
 */
export const MODULE_CAPABILITIES: ModuleCapability[] = [DOCUMENTS];

/** Only what the engine honours. This is what the interface may offer. */
export function offerableActions(source: PromptRequirement): ModuleAction[] {
  return (
    MODULE_CAPABILITIES.find((m) => m.source === source)?.actions.filter(
      (a) => a.status === "supported",
    ) ?? []
  );
}

/** Actions people will try that do something else. The honest-expectations list. */
export function divergentActions(source?: PromptRequirement): ModuleAction[] {
  return MODULE_CAPABILITIES.filter((m) => !source || m.source === source)
    .flatMap((m) => m.actions)
    .filter((a) => a.status === "routes_elsewhere");
}

/** Every declared source, for walking the registry in tests and journeys. */
export function declaredSources(): PromptRequirement[] {
  return MODULE_CAPABILITIES.map((m) => m.source).filter((s) =>
    (PROMPT_REQUIREMENTS as readonly string[]).includes(s),
  );
}
