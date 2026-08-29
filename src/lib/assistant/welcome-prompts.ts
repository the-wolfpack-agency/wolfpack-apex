/**
 * welcome-prompts.ts — role → first-day starter prompts.
 *
 * Single source of truth shared by:
 *   - The first-time welcome modal (shown once on initial /assistant
 *     visit, gated by localStorage flag).
 *   - The friendlier fallback response (rendered inline when the
 *     assistant returns a low-confidence answer, so the user has
 *     somewhere to go next instead of a dead-end).
 *
 * Why this size: every teammate gets a starting kit of 3–5 prompts
 * that work day-one for their role. More than five overwhelms
 * non-tech users; fewer doesn't show enough surface area. The first
 * three are the hero set (briefing + calendar + one role-specific);
 * the remainder are useful extras that exercise the broader tool
 * library (CRM, financials, goals, knowledge, brain upload, etc.).
 *
 * Roles map 1:1 with the role values produced by /api/auth/whoami —
 * see ROLE_HIERARCHY in tools/dispatcher.ts for the canonical list.
 * Unknown roles fall back to the generic kit so a brand-new role
 * (e.g. a future "intern") still gets something useful.
 */

export interface WelcomePrompt {
  /** The literal prompt string fed into the composer. */
  text: string;
  /** Optional short display label shown on the chip. Falls back to
   *  `text` when omitted. Lets us show "today's calendar" while still
   *  firing the longer natural-language prompt "what's on my calendar
   *  today". */
  label?: string;
  /** One-line hover description rendered as a tooltip / explainer. */
  description: string;
  /**
   * What has to be connected for this prompt to answer.
   *
   * The comment on the GitHub chips below already had the right instinct:
   * "chips that 400 on click are a worse first impression than chips that
   * don't exist". It was applied by hardcoding a role, which cannot know
   * whether a source is actually reachable today.
   *
   * Measured on production: "financials are not connected yet, so there is no
   * figure to read" was answered six times in sixty days. Every one of those
   * was somebody following a suggestion into a wall.
   *
   * Omitted means the prompt always works: it reads something local, or asks
   * the assistant about itself.
   */
  requires?: PromptRequirement;
}

/**
 * Sources a prompt can depend on.
 *
 * Deliberately coarse. A finer list would need a finer availability check, and
 * a suggestion filtered by a signal we cannot read is a suggestion we have
 * guessed about.
 */
/**
 * The sources a prompt can depend on, as a runtime list so the type and the
 * checks that walk it cannot disagree.
 *
 * Written first as a bare union with the guardrail restating its members by
 * hand, which meant adding "financials" broke the guardrail rather than being
 * covered by it. A list that has to be edited in two places drifts in one.
 */
export const PROMPT_REQUIREMENTS = [
  "calendar",
  "mail",
  "documents",
  "tasks",
  "financials",
] as const;

export type PromptRequirement = (typeof PROMPT_REQUIREMENTS)[number];

/** What is actually reachable right now, for filtering suggestions. */
export type AvailableSources = Partial<Record<PromptRequirement, boolean>>;

/* Generic kit used when role is unknown OR role is anything other
 * than `dev`. Non-dev users (the bulk of the team) get the same
 * three-prompt starter: briefing + today's calendar + inbox. GitHub
 * chips are gated to `dev` because Nick is the only teammate with a
 * GitHub login wired up — chips that 400 on click are a worse first
 * impression than chips that don't exist. */
/**
 * The question the document corpus exists to answer.
 *
 * ADDED BECAUSE NOTHING POINTED AT IT. On 2026-08-28 the Brain held 1,251
 * documents, 665 of them synced from SharePoint, all searchable, and not one
 * starter prompt in this file mentioned asking about them. The four that came
 * close were about UPLOADING. A capability nobody is told about is a
 * capability nobody uses, and this is the largest one the product has.
 *
 * Phrased as a question rather than a command because that is how people ask
 * about a document. "What do our documents say about onboarding" is what
 * somebody types; "search onboarding" is what an engineer types.
 */
/**
 * WHAT ACTUALLY WORKS, MEASURED RATHER THAN ASSUMED.
 *
 * Every shape below was typed into the live deployment on 2026-08-29 and the
 * result recorded:
 *
 *   ANSWER  "what are the payment terms in our SOW?"      2,092ms  + citation
 *   ANSWER  "when is the final payment due in our SOW?"     552ms  direct
 *   COUNT   "what do our documents say about onboarding"  1,092ms  "Found 4 results"
 *   COUNT   "what does the onboarding document say"       1,296ms  "Found 3 results"
 *   COUNT   "find documents about onboarding"             1,516ms  "Found 3 results"
 *   COUNT   "summarize the onboarding document"           1,439ms  "Found 3 results"
 *
 * The rule under it: THE PRODUCT ANSWERS QUESTIONS, IT DOES NOT TAKE DOCUMENT
 * COMMANDS. Say "documents", "find" or "summarize" and the request routes to
 * search, which returns a count and a link. Ask a direct factual question and
 * retrieval synthesises an answer with its source.
 *
 * This chip previously read "what do our documents say about onboarding",
 * which is the COUNT shape. So the one place that teaches a new person how to
 * ask was teaching the phrasing that works least well, and its description
 * promised "answer with the source attached" while returning a result count.
 *
 * Now phrased as a direct question, and the description says the rule out loud.
 * Somebody who has to guess their way to the working phrasing will conclude the
 * product cannot answer, which is the failure that matters most on day one.
 *
 * Deliberately NOT tied to a document only we hold: "our policy" is something
 * every organisation has, so the chip teaches the shape without depending on
 * one corpus.
 */
const ASK_DOCUMENTS: WelcomePrompt = {
  text: "what does our policy say about time off?",
  label: "ask a question about your documents",
  description:
    "Ask it as a question and you get the answer with its source. Asking it to " +
    "\"find\" or \"summarize\" returns a list instead.",
  requires: "documents",
};

const GENERIC_KIT: WelcomePrompt[] = [
  ASK_DOCUMENTS,
  {
    text: "briefing",
    description: "Your morning summary: schedule, emails, action items.",
  },
  {
    text: "what's on my calendar today",
    label: "today's calendar",
    description: "Your meetings and events for today.",
    requires: "calendar",
  },
  {
    text: "show me my recent emails",
    label: "inbox",
    description: "Recent unread + flagged emails.",
    requires: "mail",
  },
  {
    /* Free zero-token capability so a brand-new user with no
     * integrations still gets a useful answer from chip #4. Routes
     * to the public weather tool. */
    text: "weather",
    description: "Current conditions and a short forecast for your default location.",
  },
  {
    /* Always-available zero-auth chip. Routes to the headlines tool
     * (BBC public RSS) so demos for an unconnected workspace always
     * have a working fifth chip. */
    text: "top news",
    description: "A short public-news digest, no integrations required.",
  },
];

const ROLE_KITS: Record<string, WelcomePrompt[]> = {
  ceo: [
    ASK_DOCUMENTS,
    {
      text: "briefing",
      description: "Morning panel: today's schedule + flagged emails + action items.",
    },
    {
      text: "deals over $50k closing this month",
      description: "High-value pipeline closing this month, from the CRM.",
    },
    {
      text: "what is on my calendar this week",
      description: "Week-at-a-glance for the schedule.",
      requires: "calendar",
    },
    {
      text: "what's our MRR",
      description: "Current monthly recurring revenue from the financials store.",
      /* DECLARED, BELATEDLY. This is the prompt that most obviously depends on
         a connector and it declared nothing, so the availability filter could
         never hide it. Measured 2026-08-28: offered to a CEO on a workspace
         with no QuickBooks, answering "financials are not connected yet".
         Honest, and still a chip that dead-ends on the first click, which the
         filter above exists to prevent. */
      requires: "financials",
    },
    {
      text: "what are our OKRs",
      description: "Active objectives and key-results from the goals tracker.",
    },
  ],
  cto: [
    ASK_DOCUMENTS,
    /* CTO defaults to the non-dev kit: briefing + calendar + inbox.
     * GitHub chips are reserved for `dev` (Nick switches role to dev
     * to opt in). Non-dev demo surface is more valuable to the team
     * at large than GitHub triage chips that only one user can fire. */
    {
      text: "briefing",
      description: "Morning panel: schedule + emails + action items.",
    },
    {
      text: "what's on my calendar today",
      label: "today's calendar",
      description: "Your meetings and events for today.",
      requires: "calendar",
    },
    {
      text: "show me my recent emails",
      label: "inbox",
      description: "Recent unread + flagged emails.",
      requires: "mail",
    },
    {
      text: "what's our MRR",
      description: "Current monthly recurring revenue from the financials store.",
      /* DECLARED, BELATEDLY. This is the prompt that most obviously depends on
         a connector and it declared nothing, so the availability filter could
         never hide it. Measured 2026-08-28: offered to a CEO on a workspace
         with no QuickBooks, answering "financials are not connected yet".
         Honest, and still a chip that dead-ends on the first click, which the
         filter above exists to prevent. */
      requires: "financials",
    },
    {
      text: "upload to brain",
      description: "Drop a file into your Brain so the Assistant can cite it later.",
      requires: "documents",
    },
  ],
  vp: [
    ASK_DOCUMENTS,
    {
      text: "briefing",
      description: "Today's prep at a glance.",
    },
    {
      text: "am I free Thursday at 2pm",
      description: "Quick availability check before booking a call.",
      requires: "calendar",
    },
    {
      text: "find emails about pricing",
      description: "Pull a recent thread by topic. Swap in any subject you care about.",
      requires: "mail",
    },
    {
      text: "deals over $50k closing this month",
      description: "High-value pipeline closing this month, from the CRM.",
    },
    {
      /* WAS "tell me about our company", WHICH DEAD-ENDED.
         It routes to the verified-facts store, which holds facts somebody
         entered by hand and is empty for almost every tenant. Measured against
         production 2026-08-28: "I don't have any verified facts about 'our
         company' yet." A starter prompt is a promise, and the one thing it
         must not do is fail on the first click. This asks the documents
         instead, which every tenant has from day one. */
      text: "what do our documents say about our process",
      description: "Reads across every connected library and cites what it finds.",
    },
  ],
  pm: [
    ASK_DOCUMENTS,
    {
      text: "briefing",
      description: "Your day in one panel.",
    },
    {
      text: "what is on my calendar today",
      description: "Today's meetings, in order.",
    },
    {
      text: "create task to send the agenda",
      description: "Open the new-task form without leaving the chat.",
    },
    {
      text: "what are our OKRs",
      description: "Active objectives and key-results from the goals tracker.",
    },
    {
      text: "tasks",
      description: "Inline list of your open tasks.",
    },
  ],
  designer: [
    ASK_DOCUMENTS,
    {
      text: "briefing",
      description: "Today's schedule + flagged emails.",
    },
    {
      text: "what is on my calendar today",
      description: "Today's meetings, in order.",
    },
    {
      text: "find emails about pricing",
      description: "Pull a recent thread by topic; swap in any subject you care about.",
      requires: "mail",
    },
    {
      text: "upload to brain",
      description: "Drop a brief, deck, or reference into your Brain.",
      requires: "documents",
    },
    {
      text: "search Q2 planning",
      description: "Universal search across chats, emails, calendar, knowledge, and CRM.",
    },
  ],
  dev: [
    ASK_DOCUMENTS,
    /* `dev` is the ONLY role that surfaces GitHub chips on the welcome
     * modal. Nick is the only teammate with a wired-up GitHub login,
     * so other roles get calendar/inbox chips instead — see GENERIC_KIT
     * above. Keep both GitHub chips here so dev role retains the full
     * triage surface (open PRs + failed CI). */
    {
      text: "briefing",
      description: "Morning panel: schedule + emails + action items.",
    },
    {
      text: "what PRs are open in wolfpack-instinct",
      description: "Open pull requests across the codebase.",
    },
    {
      text: "failed CI in wolfpack-instinct",
      description: "Recent failed Actions runs to triage.",
    },
    {
      text: "upload to brain",
      description: "Drop a doc into your Brain so the Assistant can cite it later.",
      requires: "documents",
    },
    {
      text: "open issues in wolfpack-instinct",
      description: "Currently open GitHub issues, newest first.",
    },
  ],
  sales: [
    ASK_DOCUMENTS,
    {
      text: "briefing",
      description: "Today's pipeline-relevant briefing.",
    },
    {
      text: "top 3 deals",
      description: "Highest-value open opportunities.",
    },
    {
      text: "find emails about pricing",
      description: "Pull a recent thread by topic. Swap in any subject you care about.",
      requires: "mail",
    },
    {
      text: "deals over $50k closing this month",
      description: "High-value pipeline with a close date this month.",
    },
    {
      /* WAS "search the CRM for a contact", WHICH SEARCHED DOCUMENTS.
         Measured 2026-08-28: it answered "Found 3 results for 'the CRM for a
         contact': 3 documents". The phrase reads like an instruction to a
         search box, so universal search took the whole thing as the query and
         looked for those words. Nobody types a placeholder; they type a name,
         and the typed-object phrasing is what the CRM tools claim. */
      text: "find the contact for Acme",
      description: "Looks the company up in the CRM and shows who is on the account.",
    },
  ],
  ops: [
    ASK_DOCUMENTS,
    {
      text: "briefing",
      description: "Today's schedule + flagged emails.",
    },
    {
      text: "what is on my calendar today",
      description: "Today's meetings, in order.",
    },
    {
      text: "create task to send the agenda",
      description: "Open the new-task form without leaving the chat.",
    },
    {
      /* Same dead end as the CEO kit had: the verified-facts store is empty
         until somebody has corrected an answer, which has not happened on a
         tenant's first day and is exactly when this prompt is shown. */
      text: "what do our documents say about our process",
      description: "Reads across every connected library and cites what it finds.",
    },
    {
      text: "top news",
      description: "A quick public-news digest.",
    },
  ],
  hr: [
    ASK_DOCUMENTS,
    {
      text: "briefing",
      description: "Today's prep at a glance.",
    },
    {
      text: "who is on our team",
      description: "Roster lookup. Type a name after `who is` to look up a specific person.",
    },
    {
      text: "what is on my calendar today",
      description: "Today's meetings, in order.",
    },
    {
      text: "what are our OKRs",
      description: "Active objectives and key-results from the goals tracker.",
    },
    {
      text: "upload to brain",
      description: "Drop an HR policy or doc into your Brain so the Assistant can cite it.",
      requires: "documents",
    },
  ],
};

/**
 * Look up the starter kit for a given role.
 * Case-insensitive. Unknown roles fall back to GENERIC_KIT.
 *
 * Returns 3–5 prompts (the kit length is fixed per role at this
 * module; callers can slice if they want a shorter chip strip).
 */
export function welcomePromptsForRole(role: string | undefined | null): WelcomePrompt[] {
  if (!role) return GENERIC_KIT;
  return ROLE_KITS[role.toLowerCase()] ?? GENERIC_KIT;
}

/**
 * Plain-text shortcut for callers (e.g. the assistant fallback path
 * on the server) that just want the prompt strings without the
 * tooltip descriptions.
 */
export function welcomePromptTextsForRole(role: string | undefined | null): string[] {
  return welcomePromptsForRole(role).map((p) => p.text);
}

/**
 * Suggestions filtered to what will actually answer.
 *
 * WHY THIS IS NOT JUST welcomePromptsForRole. That picks by role, which is a
 * guess about what somebody wants. This removes what cannot work, which is a
 * fact about the system, and the two are different questions.
 *
 * Measured on production over sixty days: "financials are not connected yet,
 * so there is no figure to read" was answered six times. Every one of those
 * was somebody following a suggestion into a wall. A chip that dead-ends
 * teaches a new user that the product does not work, on their first try, which
 * is the most expensive moment to teach them that.
 *
 * UNKNOWN IS NOT UNAVAILABLE. A source we could not read is left in. Hiding a
 * capability because a status check timed out would quietly shrink the product
 * every time something was briefly slow, and a user who never sees a feature
 * cannot ask for it. Only an explicit false removes a prompt.
 *
 * NEVER RETURNS NOTHING. If filtering would empty the list, the unconditional
 * prompts are returned instead. An empty starter screen is a worse first
 * impression than one that offers something general, and somebody with no
 * integrations connected still deserves a way in.
 */
export function welcomePromptsFor(
  role: string | undefined | null,
  available: AvailableSources = {},
): WelcomePrompt[] {
  const kit = welcomePromptsForRole(role);

  const usable = kit.filter((p) => {
    if (!p.requires) return true;
    /* Explicit false only. undefined means "we did not check" or "we could not
       tell", and neither is a reason to hide a capability. */
    return available[p.requires] !== false;
  });

  if (usable.length === 0) return kit.filter((p) => !p.requires);

  /* LEAD WITH WHAT IS CONFIRMED WORKING.
   *
   * Filtering stops us pointing at walls. It does not tell anybody what just
   * became possible, and that is the other half: a module lands, the product
   * can suddenly do something it could not last week, and the front door still
   * offers the same list it always did.
   *
   * A prompt whose source is confirmed present goes first. Confirmed means an
   * explicit true, not merely "not false", so an unchecked source never
   * outranks one we know works.
   *
   * Stable within each group, so the order written in the kit still expresses
   * what matters for that role. This promotes; it does not reshuffle. */
  const confirmed = usable.filter((p) => p.requires && available[p.requires] === true);
  const rest = usable.filter((p) => !(p.requires && available[p.requires] === true));
  return [...confirmed, ...rest];
}

/**
 * The plain strings, filtered the same way.
 *
 * Used by the server-side fallback path, which offers somewhere to go next
 * when an answer came back thin. Suggesting a dead end at exactly that moment
 * is the worst possible time to do it.
 */
export function welcomePromptTextsFor(
  role: string | undefined | null,
  available: AvailableSources = {},
): string[] {
  return welcomePromptsFor(role, available).map((p) => p.text);
}
