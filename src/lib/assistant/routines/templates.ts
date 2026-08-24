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

/* Declared as RoutineTemplate[] BEFORE freezing so each entry is checked
   against the type rather than unioned with its siblings. Inferring first
   makes two steps with different `ask` keys collapse into a shape carrying
   `topic?: undefined`, which no longer satisfies Record<string, string>, and
   the error points at the array rather than at anything a reader can act on. */
const TEMPLATES: RoutineTemplate[] = [
  /* CHAINS SHAPED LIKE THE PLACE THIS IS BEING SOLD INTO.
     Everything below this comment was written for an agency's week: prep
     my next meeting, work through my inbox, where do things stand. All of
     it is real and none of it is how somebody at a dealership describes
     their day.
     This one is, and it is deliberately built ONLY from tools that exist
     today.

     It arrived as three. Two of them, a week-ahead chain and a customer
     catch-up, turned out to be the catalogue's own "look at the week
     ahead" and "catch me up on a client" written again in different
     words, which is what happens when you write before you read. Both
     were dropped rather than shipped as near-duplicates: a menu with two
     entries that do the same thing is worse than a shorter menu. It would be easy to write a warranty-claims chain that
     reads beautifully and cannot run; every-chain-can-run.test.ts exists
     because that has already happened once. What a client cannot do yet,
     the assistant now says plainly rather than dressing up in a chain. */
  {
    id: "tmpl_start_of_day",
    command: "start my day",
    description: "What came in overnight, what is booked, what is waiting on you, and the one thing to do first.",
    audience: "anyone",
    forRole: "Anyone running a floor, a desk or a service lane",
    outcome:
      "You know what happened while you were away and what to pick up first, before anybody asks you for it.",
    steps: [
      { kind: "tool", slot: "mail", tool: "email_thread_widget", params: { count: 15 }, label: "Reading what came in" },
      { kind: "tool", slot: "agenda", tool: "calendar_widget", params: { month: "current" }, label: "Checking what is booked" },
      { kind: "tool", slot: "tasks", tool: "task_list_widget", params: {}, label: "Checking what is waiting on you" },
      {
        kind: "model",
        slot: "first",
        prompt:
          "Overnight mail: {{mail}}\n\nToday's calendar: {{agenda}}\n\nOpen tasks: {{tasks}}\n\n" +
          "Name the ONE thing to do first and say why in a single line. Then list anything that " +
          "someone is waiting on from you, longest wait first. If nothing is urgent, say the " +
          "morning is clear rather than inventing a priority.",
        label: "Working out what comes first",
      },
      {
        kind: "human",
        label: "Do the first thing before opening anything else",
        action: "do",
        why:
          "The list is only worth the minute it took if the first item happens now. Deciding what " +
          "matters and then reading email anyway is how a morning disappears.",
        show: ["first"],
      },
    ],
  },
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
    /* THE CROSS-FUNCTION ONE, and the reason the product exists.
     *
     * Pipeline lives in the CRM, the conversation lives in mail, and what you
     * promised to do lives in tasks. Nobody has ever seen those three at once,
     * because seeing them means three windows and carrying the context between
     * them by hand. The reading is what no single tool can do.
     *
     * It writes at the end, so it stops for a person first. */
    id: "tmpl_work_the_pipeline",
    command: "work the pipeline",
    description: "Open deals, the mail around them, and what you already said you would do.",
    audience: "sales",
    forRole: "Sales and account management",
    outcome: "You know which two accounts to touch today and why, without opening three systems.",
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
        kind: "tool",
        slot: "mail",
        tool: "email_thread_widget",
        params: { count: 15 },
        label: "Reading the recent mail",
      },
      {
        kind: "tool",
        slot: "commitments",
        tool: "task_list_widget",
        params: { limit: 25 },
        label: "Checking what you already committed to",
      },
      {
        kind: "model",
        slot: "focus",
        prompt:
          "Deals this month: {{deals}}\n\nHow many are open: {{totals}}\n\n" +
          "Recent mail: {{mail}}\n\nWhat is already on your list: {{commitments}}\n\n" +
          "Which two accounts would you touch today, and why? The reason to look at " +
          "these together is the overlap: a deal that has gone quiet in the mail, or " +
          "one you promised something about and have not done. Name that connection " +
          "where it exists. Where it does not, say the data does not show one rather " +
          "than inventing a link.",
        label: "Finding where the day should go",
      },
      { kind: "human", label: "Agree the two, or pick different ones", action: "review", show: ["focus"] },
      {
        kind: "tool",
        tool: "create_task_form",
        params: {},
        label: "Logging what you decided",
      },
    ],
  },
  {
    /* A CHAIN THAT ASKS. Searching mail cannot know what to look for, and a
     * routine that guessed would search for the wrong thing confidently. It
     * asks once, then reads the CRM and the mailbox for the same name. */
    id: "tmpl_catch_up_on_a_client",
    command: "catch me up on a client",
    description: "Everything the CRM and your mailbox know about one account, read together.",
    audience: "sales",
    forRole: "Anyone walking into a client conversation",
    outcome: "You walk in knowing the last thing said and the current state, not one or the other.",
    steps: [
      {
        kind: "tool",
        slot: "record",
        tool: "search_external_records",
        params: { objectType: "account" },
        ask: { query: "Which client should I look up?" },
        label: "Finding them in the CRM",
      },
      {
        kind: "tool",
        slot: "mail",
        tool: "search_mail",
        params: {},
        ask: { topic: "And what should I search the mail for? A subject or a name is enough." },
        label: "Finding the recent mail",
      },
      {
        kind: "model",
        slot: "brief",
        prompt:
          "What the CRM has: {{record}}\n\nWhat the mail has: {{mail}}\n\n" +
          "Say where this account actually stands and what the last thing said was. " +
          "If the CRM and the mail disagree, say so plainly, because that gap is the " +
          "most useful thing here and it is exactly what nobody sees. Do not fill a " +
          "silence with a summary of the record.",
        label: "Reading both together",
      },
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
    /* READ-ONLY, AND THEREFORE NO HUMAN STEP.
     *
     * The human step exists to gate ACTION: nothing is sent, filed or told to
     * anybody without somebody agreeing. A chain that only looks things up has
     * nothing to agree to, and stopping it to ask would be friction with no
     * safety in it.
     *
     * This shape is the foundation rather than a lesser case. It is the one
     * that answers a question nobody could answer in one place before: three
     * tools whose data has never been read together, and the reading is the
     * whole product. */
    id: "tmpl_anything_on_fire",
    command: "is anything on fire",
    description: "Open issues and outstanding scan findings, read together.",
    audience: "engineer",
    forRole: "Engineering",
    outcome: "One answer to 'is there anything I should know about', instead of three tabs.",
    steps: [
      {
        kind: "tool",
        slot: "issues",
        tool: "search_github_issues",
        params: { state: "open" },
        label: "Finding open issues",
      },
      {
        kind: "tool",
        slot: "findings",
        tool: "platform_scan_findings",
        params: {},
        label: "Checking outstanding scan findings",
      },
      {
        kind: "model",
        prompt:
          "Open issues: {{issues}}\n\nScan findings: {{findings}}\n\n" +
          "Is there anything here that needs attention today, and is anything in one " +
          "list also in the other? Say plainly if nothing does: a quiet week is a " +
          "finding, and inventing an urgent item to fill the answer is worse than " +
          "saying there is none.",
        label: "Reading them together",
      },
    ],
  },
  {
    id: "tmpl_what_changed",
    command: "what changed this week",
    description: "What merged, what deployed, and what moved across the tools.",
    audience: "anyone",
    forRole: "Anyone keeping track",
    outcome: "The week in one answer, without opening GitHub, Vercel and three dashboards.",
    steps: [
      {
        kind: "tool",
        slot: "merged",
        tool: "search_github_pull_requests",
        params: { state: "closed" },
        label: "Finding what merged",
      },
      {
        kind: "tool",
        slot: "deploys",
        tool: "vercel_deployments_widget",
        params: { limit: 8 },
        label: "Finding what deployed",
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
        prompt:
          "Merged: {{merged}}\n\nDeployed: {{deploys}}\n\nSignals: {{signals}}\n\n" +
          "What actually changed this week, and does anything deployed not line up " +
          "with anything merged? Name the specific pull request or deployment. Where " +
          "the data does not connect the two, say that rather than assuming they match.",
        label: "Reading the week together",
      },
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
];

export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = Object.freeze(TEMPLATES);

/** A template by id. */
export function templateById(id: string): RoutineTemplate | null {
  return ROUTINE_TEMPLATES.find((t) => t.id === id) ?? null;
}
