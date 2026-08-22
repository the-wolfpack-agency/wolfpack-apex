/**
 * The routines that ship with the product.
 *
 * WHY THESE THREE, AND WHY NOT MORE
 *
 * Each one is a sequence somebody at this company already performs by hand,
 * every week, in four or five different windows. Nothing here is a capability
 * that did not exist yesterday; all of it is carrying that a person is
 * currently doing between tools.
 *
 * The list is short on purpose. A catalogue of twenty routines nobody asked
 * for is a menu, and a menu is another thing to read before starting work.
 * These three are the ones whose steps are all backed by tools that exist
 * today, so every one of them runs end to end rather than demonstrating an
 * intention. Anything needing a tool we have not built (a document, a deck,
 * platform-scan as a tool) is named in docs/assistant-routines.md as a gap and
 * is deliberately absent here: a routine that fails at step five is worse
 * than one that was never offered.
 *
 * EVERY ROUTINE ENDS WITH A PERSON
 *
 * Not one of these sends, files, or tells anybody anything on its own. The
 * chain assembles, the model reasons, and a human decides. That is the
 * property that makes a routine safe to hand somebody on their first day, and
 * it is enforced twice over: by the human step here, and by the confirmation
 * every write tool already requires.
 */
import type { Routine } from "./types";

export const BUILT_IN_ROUTINES: readonly Routine[] = Object.freeze([
  {
    id: "morning",
    command: "run my morning",
    description:
      "Your calendar, your tasks and a brief for your next meeting, gathered before you sit down.",
    audience: "anyone",
    steps: [
      {
        kind: "tool",
        slot: "agenda",
        tool: "calendar_widget",
        params: { month: "current" },
        label: "Reading today's calendar",
      },
      {
        kind: "tool",
        slot: "tasks",
        tool: "task_list_widget",
        params: { limit: 20 },
        label: "Collecting what is open",
      },
      {
        kind: "tool",
        slot: "brief",
        tool: "meeting_prep",
        params: {},
        label: "Preparing your next meeting",
      },
      {
        kind: "model",
        slot: "plan",
        /* The judgement is the ONLY thing asked of the person, and it is asked
           once. Four separate summaries would put the reading back on them,
           which is the work this routine exists to remove. */
        prompt:
          "Here is today's calendar: {{agenda}}\n\n" +
          "Here is what is open: {{tasks}}\n\n" +
          "Here is the brief for the next meeting: {{brief}}\n\n" +
          "Name the three things that actually matter today and say plainly what " +
          "is safe to leave. Be specific about which meeting or task you mean. If " +
          "the day looks light, say so rather than inventing priorities.",
        label: "Working out what matters",
      },
      {
        kind: "human",
        label: "Read the three, change any you disagree with",
        show: ["plan"],
      },
    ],
  },
  {
    id: "where_things_stand",
    command: "where do things stand",
    description:
      "Open PRs, open issues and what is blocked, with a message to the team ready to send.",
    audience: "engineer",
    steps: [
      {
        kind: "tool",
        slot: "prs",
        tool: "search_github_pull_requests",
        params: { state: "open" },
        label: "Finding open pull requests",
      },
      {
        kind: "tool",
        slot: "issues",
        tool: "search_github_issues",
        params: { state: "open" },
        label: "Finding open issues",
      },
      {
        kind: "model",
        slot: "standing",
        prompt:
          "Open pull requests: {{prs}}\n\n" +
          "Open issues: {{issues}}\n\n" +
          "Say what is blocked, what is waiting on a person rather than on work, " +
          "and the order you would take them in. Where something is waiting on a " +
          "named person, say who. Do not invent status you cannot see in the data.",
        label: "Working out what is blocked",
      },
      {
        kind: "human",
        label: "Accept the order, or reorder it",
        show: ["standing"],
      },
      {
        /* The chain OPENS the message and fills it in. It does not send it:
           create_message_form is a form tool, so the confirmation is the
           product's, not this routine's, and it cannot be skipped by editing a
           routine. */
        kind: "tool",
        tool: "create_message_form",
        params: {},
        label: "Opening a message to the team",
      },
    ],
  },
  {
    id: "weekly_review",
    command: "weekly review",
    description: "Goals, revenue and what moved across the tools, in one pass.",
    audience: "leadership",
    steps: [
      {
        kind: "tool",
        slot: "okrs",
        tool: "get_goals",
        params: {},
        label: "Reading the goals",
      },
      {
        kind: "tool",
        slot: "money",
        tool: "get_financials_metric",
        params: { question: "revenue this month against last month", timeframe: "this month" },
        label: "Reading the revenue position",
      },
      {
        kind: "tool",
        slot: "signals",
        tool: "cross_tool_insights_widget",
        params: { lookbackDays: 7 },
        label: "Looking across the tools",
      },
      {
        kind: "model",
        slot: "review",
        prompt:
          "Goals: {{okrs}}\n\nRevenue: {{money}}\n\nSignals across the tools: {{signals}}\n\n" +
          "Say where we are ahead, where we are behind, and what changed this week " +
          "that the numbers alone do not explain. Where the data does not support a " +
          "conclusion, say that instead of reaching for one.",
        label: "Drafting the review",
      },
      {
        kind: "human",
        label: "Correct the narrative before it goes anywhere",
        show: ["review"],
      },
    ],
  },
]);

/** Look up a routine by its id. */
export function routineById(id: string): Routine | null {
  return BUILT_IN_ROUTINES.find((r) => r.id === id) ?? null;
}

/**
 * Match what somebody typed to a routine.
 *
 * Deliberately strict: an exact command, optionally wrapped in the politeness
 * people put around a request. A fuzzy match here would occasionally fire a
 * five-step chain at somebody who was asking a question, and a chain that runs
 * uninvited is far worse than one that did not recognise its own name.
 */
export function matchRoutine(message: string): Routine | null {
  const text = message
    .trim()
    .toLowerCase()
    .replace(/^(?:please\s+|can\s+you\s+|could\s+you\s+)+/, "")
    .replace(/[.!?]+$/, "")
    .trim();
  return BUILT_IN_ROUTINES.find((r) => text === r.command) ?? null;
}
