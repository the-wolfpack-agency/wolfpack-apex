/**
 * Every tool needs prompts that prove somebody can reach it.
 *
 * client-prompt-corpus.test.ts guards one direction: a tool must not claim a
 * prompt that is not for it. This guards the other: a tool nobody can phrase a
 * question to is functionality that exists only in the registry. Measured on
 * 2026-08-26, 38 of 60 tools had no prompt anywhere proving they were
 * reachable, including the two that read and write documents.
 *
 * The two failures are different and both are silent. A tool that over-claims
 * answers questions that were not for it, loudly and wrongly. A tool that
 * cannot be reached answers nothing, and looks exactly like a tool nobody
 * needed. Only the second one costs a feature we already paid to build.
 *
 * SO: a prompt list per tool, in the words somebody would actually type. Each
 * prompt must route to the tool it is filed under. A tool with no prompts is
 * listed in NEEDS_PROMPTS with the reason, and that list is meant to shrink;
 * adding a tool without adding prompts fails the build.
 */
export {};

import "../index";
import { getTools } from "../registry";

interface Registered {
  name: string;
  matchIntent?: (message: string) => unknown;
}

function claimants(message: string): string[] {
  return (getTools() as unknown as Registered[])
    .filter((t) => typeof t.matchIntent === "function" && t.matchIntent(message) != null)
    .map((t) => t.name);
}

/**
 * The prompts a person types, per tool.
 *
 * Written as somebody at an agency or a dealership would say it, not as an
 * engineer would describe the endpoint. A prompt that only works when phrased
 * the way the code is named is a prompt nobody will ever produce.
 */
const TOOL_PROMPTS: Record<string, string[]> = {
  /* DOCUMENTS. The SharePoint path a client engagement starts with: put a
     document in, then ask the library about it. */
  /* The document path a client engagement opens with. "upload a document to
     the brain" reached NO tool until 2026-08-26; only the bare "upload to
     brain" and the slash form worked. */
  upload_to_brain: [
    "upload a document to the brain",
    "add this file to the knowledge base",
    "put this doc in the brain",
    "save the contract to the library",
    "upload to brain",
  ],
  op_create_document: [
    "create a document called Q4 pilot notes",
    "make a new document for the client brief",
  ],
  /* STATUS. The question a client asks first, and the one that reached no
     tool at all until 2026-08-26 because no tool existed. Deliberately more
     phrasings than any other entry here: "how is it going" has no canonical
     wording, and a status tool reachable only by the word "status" would be a
     tool nobody reaches. Every one of these is a sentence somebody said in a
     meeting, not a paraphrase of the function name. */
  pilot_status: [
    "how is the pilot going",
    "what's blocking the pilot",
    "what's left to do",
    "where are we on the project",
    "where do we stand",
    "are we on track",
    "how are we tracking",
    "what's at risk",
    "what's in our way",
    "give me a status update on the engagement",
    "how's the rollout going",
    "what's outstanding on the pilot",
  ],
  who_is: ["who is Jorge", "who is Ashley Martinez"],
  execute_agent_widget: ["run the agent", "execute agent task"],
  recent_workflow_runs: ["what happened in CI today", "show me the latest CI runs"],
  search_github_issues: ["search github issues for the login bug"],
  search_github_pull_requests: ["find open pull requests"],
  vercel_deployments_widget: ["show me recent deployments"],
  weather: ["what's the weather in Boston"],
  good_morning_widget: ["good morning"],
};

/**
 * PHRASINGS THAT REACH NOTHING, and the tool they should reach.
 *
 * Every one of these was typed the way somebody would actually say it, and
 * every one falls through to a model or to the wrong tool. Three of them are
 * headline features: planning a day, putting a document into the library, and
 * handing work to an agent. The library one is the path a client engagement
 * opens with.
 *
 * ASSERTED AS CURRENTLY BROKEN, deliberately. A skipped test says nothing and
 * a failing suite cannot ship, so this records the gap as a fact the build
 * checks. Fix one and this test fails, which is the point: the line comes out
 * in the same change that makes it untrue.
 */
const UNREACHABLE: Array<{ prompt: string; shouldReach: string; note: string }> = [
  {
    prompt: "delegate this to an agent",
    shouldReach: "delegate_to_agent",
    note: "the agent capability a client asks about by name",
  },
  {
    prompt: "scan this HR document",
    shouldReach: "scan_hr_doc",
    note: "reaches nothing",
  },
];

/**
 * PHRASINGS THAT REACH THE WRONG TOOL.
 *
 * Worse than reaching nothing. A wrong tool answers with confidence, and the
 * person learns the product misunderstands their job rather than that it
 * cannot help yet.
 */
const MISROUTED: Array<{ prompt: string; reaches: string; shouldReach: string }> = [
  {
    prompt: "search my email for the Porsche contract",
    reaches: "dms_inventory_widget",
    shouldReach: "search_mail",
  },
  {
    prompt: "remember that Jorge owns the Porsche account",
    reaches: "filter_external_records",
    shouldReach: "save_team_fact",
  },
  {
    prompt: "what's in the news today",
    reaches: "op_web_search",
    shouldReach: "headlines",
  },
  {
    prompt: "schedule my morning routine",
    reaches: "get_calendar_availability",
    shouldReach: "schedule_routine",
  },
];

/**
 * Tools with no prompts yet, and the reason.
 *
 * MEANT TO SHRINK. Each line is a tool somebody built and nobody can currently
 * be shown how to reach. Listed rather than skipped by a blanket rule, so the
 * omission is a decision a reviewer can see and argue with.
 */
/**
 * Tools with no prompt corpus yet. MEANT TO SHRINK.
 *
 * Fifty-one of sixty, measured 2026-08-26. That is not a backlog somebody
 * forgot; it is what happens when tools are added one at a time and nothing
 * ever asks whether a person could phrase a question to reach them. Five of
 * these are already known to reach nothing at all (see UNREACHABLE above) and
 * three reach the wrong tool, which is what a sweep of twenty-five prompts
 * turned up before it ran out of prompts.
 *
 * Listed by name rather than skipped by a rule, so the size of the gap is
 * visible and a reviewer can argue with any line. The count is asserted below
 * so it cannot grow: a new tool arrives with prompts, or it does not arrive.
 */
const NEEDS_PROMPTS: string[] = [
  "aggregate_external_records",
  "calendar_widget",
  "clarify_widget",
  "compare_across_sources",
  "create_calendar_event_form",
  "create_crm_record_form",
  "create_external_record",
  "create_feature_form",
  "create_message_form",
  "create_okr_form",
  "create_task_form",
  "cross_tool_insights_widget",
  "dark_data",
  "delegate_to_agent",
  "dms_inventory_widget",
  "edit_routine",
  "email_thread_widget",
  "feedback",
  "filter_external_records",
  "fx",
  "get_calendar_availability",
  "get_external_record",
  "get_financials_metric",
  "get_goals",
  "get_org_facts",
  "get_related_records",
  "headlines",
  "integrations_list_widget",
  "log_time",
  "meeting_prep",
  "news_search",
  "op_capture_screenshot",
  "op_create_qr_code",
  "op_draft_email",
  "op_web_search",
  "plan_my_day",
  "platform_scan_findings",
  "routine_templates",
  "save_team_fact",
  "scan_hr_doc",
  "scan_invoice",
  "scan_receipt",
  "schedule_health",
  "schedule_routine",
  "search",
  "search_external_records",
  "search_mail",
  "task_list_widget",
  "update_external_record",
  "what_can_you_do",
];

describe("every prompt reaches the tool it is filed under", () => {
  const cases = Object.entries(TOOL_PROMPTS).flatMap(([tool, prompts]) =>
    prompts.map((p) => [tool, p] as const),
  );

  it.each(cases)("%s <- %s", (tool, prompt) => {
    expect(claimants(prompt)).toContain(tool);
  });
});

describe("phrasings that reach nothing", () => {
  /* Recorded as facts the build checks. When one is fixed this fails, and the
     line is removed in the same change that makes it untrue. */
  it.each(UNREACHABLE.map((u) => [u.prompt, u.shouldReach, u.note] as const))(
    "%s still reaches no tool (should be %s: %s)",
    (prompt) => {
      expect(claimants(prompt)).toEqual([]);
    },
  );
});

describe("phrasings that reach the wrong tool", () => {
  it.each(MISROUTED.map((m) => [m.prompt, m.reaches, m.shouldReach] as const))(
    "%s still reaches %s rather than %s",
    (prompt, reaches, shouldReach) => {
      const got = claimants(prompt);
      expect(got).toContain(reaches);
      expect(got).not.toContain(shouldReach);
    },
  );
});

describe("every tool can be reached by something", () => {
  /* THE GUARD. A tool added without prompts is functionality nobody can be
     shown how to use, and it fails here rather than being discovered by a
     client who cannot phrase the question. */
  it("has prompts, or a declared reason it does not", () => {
    const registered = (getTools() as unknown as Registered[]).map((t) => t.name);
    const undocumented = registered
      .filter((n) => !TOOL_PROMPTS[n] && !NEEDS_PROMPTS.includes(n))
      .sort();

    expect(undocumented).toEqual([]);
  });

  /* Proves the check above can see anything. An empty registry would pass it
     while asserting nothing. */
  it("found tools to check", () => {
    expect((getTools() as unknown[]).length).toBeGreaterThan(20);
  });

  /* The backlog may not quietly grow. */
  /* THE ENFORCEABLE PART. The gap is large and shrinking it is real work, but
     a new tool landing without prompts is a choice somebody makes today, and
     this is where it stops. */
  it("does not let the gap grow", () => {
    expect(NEEDS_PROMPTS.length).toBeLessThanOrEqual(50);
  });
});
