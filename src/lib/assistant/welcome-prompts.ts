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
 * Why these three: per the internal rollout plan, every teammate gets
 * a starting kit of 3 prompts that work day-one for their role. More
 * than three overwhelms non-tech users; fewer doesn't show enough
 * surface area. Three is the sweet spot.
 *
 * Roles map 1:1 with the role values produced by /api/auth/whoami —
 * see ROLE_HIERARCHY in tools/dispatcher.ts for the canonical list.
 * Unknown roles fall back to the generic kit so a brand-new role
 * (e.g. a future "intern") still gets something useful.
 */

export interface WelcomePrompt {
  /** The literal prompt string fed into the composer. */
  text: string;
  /** One-line hover description rendered as a tooltip / explainer. */
  description: string;
}

/* Generic kit used when role is unknown. Bias toward "every team
 * member gets value from these" — briefing, calendar, knowledge. */
const GENERIC_KIT: WelcomePrompt[] = [
  {
    text: "briefing",
    description: "Your morning summary: schedule, emails, action items.",
  },
  {
    text: "what is on my calendar today",
    description: "Today's meetings, in order.",
  },
  {
    text: "what do we know about <client>",
    description: "Pull internal knowledge before a call (replace <client>).",
  },
];

const ROLE_KITS: Record<string, WelcomePrompt[]> = {
  ceo: [
    {
      text: "briefing",
      description: "Morning panel: today's schedule + flagged emails + action items.",
    },
    {
      text: "top 3 deals",
      description: "Highest-value open opportunities from the CRM.",
    },
    {
      text: "what is on my calendar this week",
      description: "Week-at-a-glance for the schedule.",
    },
  ],
  cto: [
    {
      text: "briefing",
      description: "Morning panel: schedule + emails + action items.",
    },
    {
      text: "what PRs are open in wolfpack-apex",
      description: "Open pull requests across the codebase.",
    },
    {
      text: "failed CI in wolfpack-apex",
      description: "Recent failed Actions runs to triage.",
    },
  ],
  vp: [
    {
      text: "briefing",
      description: "Today's prep at a glance.",
    },
    {
      text: "am I free Thursday at 2pm",
      description: "Quick availability check before booking a call.",
    },
    {
      text: "find emails from <client>",
      description: "Pull recent thread before the next conversation.",
    },
  ],
  pm: [
    {
      text: "briefing",
      description: "Your day in one panel.",
    },
    {
      text: "what is on my calendar today",
      description: "Today's meetings, in order.",
    },
    {
      text: "create task to <thing> by friday",
      description: "Add a new task without leaving the chat.",
    },
  ],
  designer: [
    {
      text: "briefing",
      description: "Today's schedule + flagged emails.",
    },
    {
      text: "what is on my calendar today",
      description: "Today's meetings, in order.",
    },
    {
      text: "find emails from <client>",
      description: "Pull recent client thread (replace <client>).",
    },
  ],
  dev: [
    {
      text: "briefing",
      description: "Morning panel: schedule + emails + action items.",
    },
    {
      text: "what PRs are open in wolfpack-apex",
      description: "Open pull requests across the codebase.",
    },
    {
      text: "create task to <thing>",
      description: "Add a task to Microsoft To Do.",
    },
  ],
  sales: [
    {
      text: "briefing",
      description: "Today's pipeline-relevant briefing.",
    },
    {
      text: "top 3 deals",
      description: "Highest-value open opportunities.",
    },
    {
      text: "find emails from <client>",
      description: "Pull recent thread before a call.",
    },
  ],
  ops: [
    {
      text: "briefing",
      description: "Today's schedule + flagged emails.",
    },
    {
      text: "what is on my calendar today",
      description: "Today's meetings, in order.",
    },
    {
      text: "create task to <thing> by friday",
      description: "Add a task without leaving the chat.",
    },
  ],
  hr: [
    {
      text: "briefing",
      description: "Today's prep at a glance.",
    },
    {
      text: "who is <teammate>",
      description: "Look up a teammate's role + email.",
    },
    {
      text: "what is on my calendar today",
      description: "Today's meetings, in order.",
    },
  ],
};

/**
 * Look up the 3-prompt starter kit for a given role.
 * Case-insensitive. Unknown roles fall back to GENERIC_KIT.
 *
 * Always returns exactly 3 prompts so the UI never has to handle a
 * variable-length empty/short array.
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
