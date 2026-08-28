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
export type PromptRequirement = "calendar" | "mail" | "documents" | "tasks";

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
const ASK_DOCUMENTS: WelcomePrompt = {
  text: "what do our documents say about onboarding",
  label: "ask our documents",
  description: "Search everything synced from SharePoint and answer with the source attached.",
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
      text: "tell me about our company",
      description: "One-line org summary pulled from the knowledge store.",
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
      text: "search the CRM for a contact",
      description: "Universal-search phrasing that fans into the CRM alongside chat, email, calendar, and knowledge.",
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
      text: "tell me about our company",
      description: "One-line org summary from the knowledge store.",
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
