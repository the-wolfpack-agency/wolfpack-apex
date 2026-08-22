/**
 * Workflows somebody can adopt instead of describing.
 *
 * WHY A LIBRARY AT ALL, WHEN THE PRODUCT CAN BUILD ONE FROM A DESCRIPTION
 *
 * Describing your day is the better path once you know the product can do
 * something with it. On day one, nobody knows that. A person looking at an
 * empty assistant does not think "I should narrate my Monday"; they think
 * "what is this for". A library answers that in the only way that lands: by
 * showing work they recognise as their own.
 *
 * IT MUST NEVER OFFER SOMETHING THAT WILL NOT RUN
 *
 * A catalogue that half-fails on contact is worse than a short one. Every
 * template here is checked against the LIVE registry and the reader's own role
 * before it is offered, using the same checkRoutine that guards a saved chain
 * (see heal.ts). The library says "6 of these will work for you today, and
 * these 3 need HubSpot connected" rather than letting somebody find out by
 * adopting one.
 *
 * EVERY STEP USES PARAMETERS THAT ARE VALID ANYWHERE
 *
 * A template cannot know a workspace's repo names, customers or projects, and a
 * step needing one would be a template that only works for whoever wrote it.
 * Anything that needs a local detail is left out, and the assertion that every
 * template validates against the real registry lives in the tests.
 *
 * ADOPTING ONE IS NOT THE END. It is a starting shape somebody then changes,
 * which is why each carries a human step and a description in their words
 * rather than ours.
 */
import type { Routine } from "./types";

export interface RoutineTemplate extends Routine {
  /** Who tends to want this. Presentation only; authority stays with the gate. */
  forRole: string;
  /** In one line, what somebody gets back. Shown in the library. */
  outcome: string;
}

export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = Object.freeze([
  {
    id: "tmpl_meeting_prep",
    command: "prep my next meeting",
    description: "What is on today, a brief for the next meeting, and a moment to rehearse.",
    audience: "anyone",
    forRole: "Anyone with meetings",
    outcome: "You walk in having read the brief rather than skimming it in the corridor.",
    steps: [
      { kind: "tool", slot: "agenda", tool: "calendar_widget", params: { month: "current" }, label: "Checking what is on today" },
      { kind: "tool", slot: "brief", tool: "meeting_prep", params: {}, label: "Preparing the next meeting" },
      {
        kind: "model",
        slot: "angle",
        prompt:
          "Today's calendar: {{agenda}}\n\nBrief for the next meeting: {{brief}}\n\n" +
          "In three lines: what is this meeting for, what does the other side most likely want, " +
          "and what is the one thing worth saying first. If the brief is thin, say so rather than padding it.",
        label: "Working out the angle",
      },
      {
        kind: "human",
        label: "Read the opening out loud once",
        action: "do",
        /* A "do" step with a reason attached. Somebody told to rehearse with no
           reason skips it, and the skip then reads as the step being pointless
           rather than unexplained. */
        why: "Saying it out loud is where a weak opening becomes obvious. Thirty seconds here is the difference between reading a brief and being ready.",
        show: ["angle"],
      },
    ],
  },
  {
    id: "tmpl_inbox_pass",
    command: "work through my inbox",
    description: "Recent mail, what actually needs an answer, and the follow-ups logged.",
    audience: "anyone",
    forRole: "Anyone with a mailbox",
    outcome: "The reading and the triage are done, and nothing you decided to answer gets forgotten.",
    steps: [
      { kind: "tool", slot: "mail", tool: "email_thread_widget", params: { count: 15 }, label: "Reading recent mail" },
      {
        kind: "model",
        slot: "triage",
        prompt:
          "Recent mail: {{mail}}\n\nWhich of these actually need an answer from me today, and which " +
          "can wait or need nothing? Be specific about who and about what. Do not invent anything " +
          "that is not in the list.",
        label: "Working out what needs an answer",
      },
      { kind: "human", label: "Pick the ones worth answering", action: "review", show: ["triage"] },
      /* A TASK, NOT A DRAFT, and that is a limitation worth being honest about.
         The compose surface (create_email_form) is switched off in this
         product, so a template that opened a draft would be a template that
         fails on adoption. Logging the follow-up is the useful thing that can
         actually happen, and it is still a form tool, so the confirmation
         belongs to the product rather than to this template. */
      { kind: "tool", tool: "create_task_form", params: {}, label: "Logging the follow-ups" },
    ],
  },
  {
    id: "tmpl_pipeline",
    command: "check the pipeline",
    description: "Open deals, where they are stuck, and what is worth a call today.",
    audience: "sales",
    forRole: "Sales",
    outcome: "You start the day knowing which two deals to touch, not scrolling a CRM list.",
    steps: [
      {
        kind: "tool",
        slot: "deals",
        tool: "filter_external_records",
        params: { objectType: "deal", filters: { dateRange: "this_month" } },
        label: "Pulling this month's deals",
      },
      {
        kind: "tool",
        slot: "totals",
        tool: "aggregate_external_records",
        params: { objectType: "deal", operation: "count" },
        label: "Counting what is open",
      },
      {
        kind: "model",
        slot: "focus",
        prompt:
          "Deals this month: {{deals}}\n\nHow many are open: {{totals}}\n\n" +
          "Which two would you touch today and why? Name them. If the data does not support " +
          "picking, say that instead of choosing at random.",
        label: "Working out where to spend the day",
      },
      { kind: "human", label: "Agree the two, or pick different ones", action: "review", show: ["focus"] },
    ],
  },
  {
    id: "tmpl_release_readiness",
    command: "check release readiness",
    description: "Open PRs, open issues and outstanding scan findings, read together.",
    audience: "engineer",
    forRole: "Engineering",
    outcome: "One answer to 'can we ship', instead of four tabs and a guess.",
    steps: [
      { kind: "tool", slot: "prs", tool: "search_github_pull_requests", params: { state: "open" }, label: "Finding open pull requests" },
      { kind: "tool", slot: "issues", tool: "search_github_issues", params: { state: "open" }, label: "Finding open issues" },
      { kind: "tool", slot: "findings", tool: "platform_scan_findings", params: {}, label: "Checking outstanding scan findings" },
      {
        kind: "model",
        slot: "verdict",
        prompt:
          "Open PRs: {{prs}}\n\nOpen issues: {{issues}}\n\nScan findings: {{findings}}\n\n" +
          "Is there anything here that should stop a release, and what is merely untidy? " +
          "Say plainly where the data does not tell you, rather than reassuring me.",
        label: "Reading it together",
      },
      { kind: "human", label: "Make the call", action: "review", show: ["verdict"] },
    ],
  },
  {
    id: "tmpl_money_check",
    command: "check the numbers",
    description: "Where revenue stands, against the goals it is supposed to serve.",
    audience: "leadership",
    forRole: "Leadership",
    outcome: "The position and the goals in one place, so the gap is obvious.",
    steps: [
      {
        kind: "tool",
        slot: "money",
        tool: "get_financials_metric",
        params: { question: "revenue this month against last month", timeframe: "this month" },
        label: "Reading the revenue position",
      },
      { kind: "tool", slot: "goals", tool: "get_goals", params: {}, label: "Reading the goals" },
      {
        kind: "model",
        slot: "gap",
        prompt:
          "Revenue: {{money}}\n\nGoals: {{goals}}\n\nWhere are we against what we said we would do, " +
          "and what does the number not explain? If a goal has no number attached, say so rather " +
          "than inventing progress against it.",
        label: "Working out the gap",
      },
      { kind: "human", label: "Correct anything the numbers get wrong", action: "review", show: ["gap"] },
    ],
  },
  {
    id: "tmpl_week_ahead",
    command: "look at the week ahead",
    description: "What is scheduled, what is open, and what has moved across the tools.",
    audience: "anyone",
    forRole: "Anyone",
    outcome: "Monday starts with a plan rather than an inbox.",
    steps: [
      { kind: "tool", slot: "agenda", tool: "calendar_widget", params: { month: "current" }, label: "Reading the calendar" },
      { kind: "tool", slot: "tasks", tool: "task_list_widget", params: { limit: 25 }, label: "Collecting what is open" },
      { kind: "tool", slot: "signals", tool: "cross_tool_insights_widget", params: { lookbackDays: 7 }, label: "Looking across the tools" },
      {
        kind: "model",
        slot: "plan",
        prompt:
          "Calendar: {{agenda}}\n\nOpen work: {{tasks}}\n\nSignals: {{signals}}\n\n" +
          "What does this week actually demand, what is at risk of not happening, and what could " +
          "be dropped without anybody minding? Be concrete and do not pad the list.",
        label: "Working out the week",
      },
      { kind: "human", label: "Decide what the week is really for", action: "do", why: "This is the one judgement nothing here can make for you, and it is the one that decides how the week goes.", show: ["plan"] },
    ],
  },
]);

/** A template by id. */
export function templateById(id: string): RoutineTemplate | null {
  return ROUTINE_TEMPLATES.find((t) => t.id === id) ?? null;
}
