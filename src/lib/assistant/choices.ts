/**
 * When the assistant does not know, offer choices instead of an apology.
 *
 * The fallback today is a sentence: "I don't have a confident answer for that.
 * Could you rephrase, or open a support ticket so a human can look at it?" It
 * costs about eleven hundred tokens to produce, it teaches the person nothing
 * about what the product can do, and the one instruction it gives is to try
 * again with better words, which is the thing they already failed at.
 *
 * A chip costs nothing and cannot be misrouted. Clicking it sends a phrasing
 * we know routes to a real tool, so the answer is deterministic, and the set of
 * chips doubles as the only discoverability surface the assistant has.
 *
 * EVERY CHIP IS A PHRASING THAT PROVABLY WORKS. The queries come from the tool
 * prompt corpus, which is asserted in tests to route to the tool it is filed
 * under. A chip cannot drift into a sentence that reaches nothing, because the
 * build fails first. That is the difference between this and a hand-written
 * list of suggestions, which is what the existing typo-catcher uses and which
 * goes stale the moment a matcher changes.
 *
 * NEVER OFFER A CONTROL THE PERSON CANNOT USE. Chips are filtered by the same
 * capability gate the tools themselves enforce. A chip that returns "you lack
 * the privilege" is the role-mismatch defect wearing a friendlier coat: the API
 * refusing is correct, and the control should never have been on their screen.
 */
import { canInvokeNamedTool } from "@/lib/assistant/tools/gate";
import { getTools } from "@/lib/assistant/tools/registry";
import type { ClarifySuggestion } from "@/lib/assistant/widgets/types";

/**
 * What a tool can do, said the way somebody would ask for it.
 *
 * `query` is the phrasing sent on click and must be one the matcher claims.
 * `label` is what the chip reads, which is shorter and in the imperative,
 * because a chip is a button rather than a sentence.
 */
export interface Choice {
  tool: string;
  label: string;
  query: string;
  hint: string;
  /** Words that make this choice relevant to what was typed. */
  keywords: string[];
  /**
   * The integration this chip dead-ends without.
   *
   * Undefined means it works from the product's own data and can always be
   * offered. Named means the chip is only shown when that integration is not
   * KNOWN to be disconnected: QuickBooks has never held a token on this
   * deployment, so "A financial figure" has been offered to every person who
   * ever saw the fallback and has never once been able to answer.
   */
  requires?: "microsoft" | "quickbooks" | "github";
}

/**
 * The offerable set.
 *
 * Deliberately small. A wall of twenty chips is a menu nobody reads, and the
 * point is to move somebody forward rather than to inventory the product.
 * These are the surfaces with real production traffic plus the two a client
 * asks about by name.
 */
export const CHOICES: Choice[] = [
  {
    tool: "upload_to_brain",
    label: "Add a document",
    query: "upload a document to the brain",
    hint: "Put a file into the library so it can be answered from",
    keywords: ["upload", "document", "file", "add", "doc", "pdf", "library", "sharepoint", "brain"],
  },
  {
    tool: "search",
    label: "Search everything",
    query: "search for",
    hint: "Across documents, email, calendar and people",
    keywords: ["search", "find", "look", "where", "locate"],
  },
  {
    tool: "calendar_widget",
    requires: "microsoft",
    label: "My calendar",
    query: "what's on my calendar today",
    hint: "Today's meetings",
    keywords: ["calendar", "meeting", "schedule", "today", "tomorrow", "free", "busy"],
  },
  {
    tool: "search_mail",
    requires: "microsoft",
    label: "Search email",
    query: "find emails about",
    hint: "Your inbox and sent items",
    keywords: ["email", "mail", "inbox", "message", "sent", "wrote"],
  },
  {
    tool: "who_is",
    label: "Look up a person",
    query: "who is",
    hint: "Role, team and recent work",
    keywords: ["who", "person", "people", "team", "colleague", "works"],
  },
  {
    tool: "get_financials_metric",
    requires: "quickbooks",
    label: "A financial figure",
    query: "what was our revenue last month",
    hint: "Revenue, profit, cash, invoices",
    keywords: ["revenue", "mrr", "arr", "profit", "cash", "invoice", "financial", "money", "burn"],
  },
  {
    tool: "recent_workflow_runs",
    requires: "github",
    label: "CI status",
    query: "what happened in CI today",
    hint: "Recent workflow runs",
    keywords: ["ci", "build", "pipeline", "workflow", "deploy", "test"],
  },
  {
    tool: "feedback",
    label: "Report a problem",
    query: "feedback:",
    hint: "Goes straight to the team",
    keywords: ["broken", "bug", "wrong", "problem", "issue", "not working", "feedback"],
  },
];

/** Words too common to signal anything. */
const STOP = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "what", "who",
  "how", "when", "where", "why", "our", "my", "me", "i", "we", "you", "to", "for",
  "of", "in", "on", "and", "or", "can", "could", "would", "show", "tell", "give",
]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * How well a choice answers what was typed.
 *
 * Overlap of meaningful words. Deliberately crude: this decides an ORDER, not
 * an answer, and a cheap wrong order costs somebody one glance while a model
 * call to rank chips would cost more than the fallback it replaces.
 */
export function scoreChoice(question: string, choice: Choice): number {
  const asked = new Set(words(question));
  if (asked.size === 0) return 0;
  let hits = 0;
  for (const k of choice.keywords) if (asked.has(k)) hits++;
  return hits;
}

/**
 * The chips to offer, best first.
 *
 * Returns an empty array rather than a default menu when the person's role can
 * reach nothing here. Offering chips that all refuse is worse than offering
 * none: it spends their click and teaches them the product is broken.
 */
export interface BuildChoicesOpts {
  limit?: number;
  /**
   * Integrations KNOWN to be disconnected. A chip requiring one of these is
   * dropped.
   *
   * DELIBERATELY A DISCONNECTED SET RATHER THAN A CONNECTED ONE. If the
   * connection lookup fails we know nothing, and an empty connected-set would
   * silently hide every integration chip and leave somebody staring at two
   * options. Naming only what we can positively prove is unusable means a
   * transient database blip costs nothing, while the case that actually bites
   * (QuickBooks, never connected, zero token rows) is still fixed.
   */
  knownDisconnected?: ReadonlySet<string>;
}

export function buildChoices(
  question: string,
  role: string,
  opts: BuildChoicesOpts | number = {},
): ClarifySuggestion[] {
  /* Number form kept so existing callers and tests are untouched. */
  const { limit = 4, knownDisconnected } =
    typeof opts === "number" ? { limit: opts, knownDisconnected: undefined } : opts;
  /* The capability comes from the tool's own declaration rather than being
     repeated here. Two copies of a permission is how a chip comes to be
     offered for something the API will refuse. */
  const registered = new Map(
    (getTools() as unknown as Array<{ name: string; capability?: string }>).map((t) => [
      t.name,
      t.capability ?? "*",
    ]),
  );

  const allowed = CHOICES.filter((c) => {
    const capability = registered.get(c.tool);
    /* A chip naming a tool that is not registered is a chip that cannot work.
       Dropped rather than offered, and the coverage test below fails so
       somebody fixes the list rather than the symptom. */
    if (capability === undefined) return false;
    /* A CHIP THAT CANNOT WORK IS WORSE THAN NO CHIP. It spends somebody's
       click to teach them the product is broken, which is the role-mismatch
       defect wearing a friendlier coat. */
    if (c.requires && knownDisconnected?.has(c.requires)) return false;
    return canInvokeNamedTool(role, c.tool, capability);
  });
  if (allowed.length === 0) return [];

  const scored = allowed
    .map((c) => ({ c, score: scoreChoice(question, c) }))
    /* Stable: score first, then the declared order, so the same question
       always produces the same chips in the same places. A menu that moves
       between asks is a menu people stop trusting. */
    .sort((a, b) => b.score - a.score || CHOICES.indexOf(a.c) - CHOICES.indexOf(b.c));

  return scored.slice(0, limit).map(({ c }) => ({
    label: c.label,
    query: c.query,
    hint: c.hint,
  }));
}
