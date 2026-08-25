/**
 * The front door.
 *
 * day-plan.test.ts proves the mapping. This proves the tool spends a model call
 * only when there is something to work with, offers the model only what this
 * person may run, and degrades into a sentence rather than an error.
 */
import { planMyDayTool, matchPlanDayIntent } from "../plan-my-day-tool";

const mockComplete = jest.fn();
const mockSavePending = jest.fn();
jest.mock("../pending-actions", () => ({
  ...jest.requireActual("../pending-actions"),
  savePendingAction: (...a: unknown[]) => mockSavePending(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/ai/router", () => ({
  getAIClient: () => ({ complete: (...a: unknown[]) => mockComplete(...a) }),
}));

import "../index";

const DAY =
  "Here's what I do on a Monday: I read the overnight email, check my calendar, rehearse the client pitch out loud, then send the team a status note.";

const run = (role = "cto", description = DAY) =>
  planMyDayTool.handler({ description } as never, {
    userId: "u1",
    userRole: role,
    workspaceId: "w1",
  } as never);

beforeEach(() => {
  jest.clearAllMocks();
  /* The offer is only answerable if the row behind it exists, so the happy
     path has to say that it does. */
  mockSavePending.mockResolvedValue({ id: "p1", description: "d", saved: true });
  mockComplete.mockResolvedValue({
    content: JSON.stringify({
      steps: [
        { text: "Read the overnight email", tool: "search_mail", humanOnly: false },
        { text: "Check my calendar", tool: "calendar_widget", humanOnly: false },
        { text: "Rehearse the client pitch out loud", tool: null, humanOnly: true },
        { text: "Send the team a status note", tool: "create_message_form", humanOnly: false },
      ],
    }),
  });
});

/* ---------------------------------------------------------------------
 * Found by scripts/phrase-sweep.ts, which runs every phrasing through the
 * real matchers: two ways of describing a working day were being answered by
 * the CRM record search instead of the day planner.
 * --------------------------------------------------------------- */
describe("how people actually describe their day", () => {
  /* "here's" and "here is" are the same sentence. The matcher read here'?s?,
     which cannot span the space, so one of them was a day description and the
     other was a database query. */
  it.each([
    "here is what I do each Monday: inbox, then the pipeline, then the team call",
    "here's what I do each Monday: inbox, then the pipeline, then the team call",
  ])("%s is a day", (m) => {
    expect(matchPlanDayIntent(m)).not.toBeNull();
  });

  /* Nobody announces that they are about to describe their day. They just
     start, and that is the single most useful thing anybody can type here. */
  it("takes a routine described without any announcement", () => {
    expect(
      matchPlanDayIntent(
        "every morning I read my email, check the calendar and chase the overnight leads",
      ),
    ).not.toBeNull();
  });

  /* THE RISK THE WIDENING CREATES, and the reason it asks for a list rather
     than a single comma. Every one of these begins exactly like a described
     routine and none of them is one; the first three are bug reports, which
     must reach feedback. Answering somebody who says the product is broken
     with a planning exercise is the worst response available at the moment
     their words matter most. */
  it.each([
    "every day I have to log in again, the session expires too quickly",
    "every morning I get an error on the dashboard, can you fix it",
    "each week I see the same bug in the report, it is really annoying",
    "every day I am getting complaints about the login page from users",
  ])("%s is NOT a day", (m) => {
    expect(matchPlanDayIntent(m)).toBeNull();
  });
});

describe("knowing when to spend a model call", () => {
  it("matches somebody walking through their day", () => {
    expect(matchPlanDayIntent(DAY)).toEqual({ description: DAY });
  });

  it("ignores a three-word mention of a day", () => {
    /* "my day" must not cost a model call. */
    expect(matchPlanDayIntent("my day")).toBeNull();
    expect(matchPlanDayIntent("plan my day")).toBeNull();
  });

  it("ignores an ordinary question that happens to mention a day", () => {
    expect(
      matchPlanDayIntent("what does my day look like tomorrow, and is the review still on"),
    ).toBeNull();
  });

  it("refuses an essay, rather than paying to summarise one", () => {
    expect(matchPlanDayIntent(`Here's what I do: ${"x".repeat(5000)}`)).toBeNull();
  });
});

describe("what the model is allowed to see", () => {
  it("offers only tools this person can run", async () => {
    await run("sales");
    const prompt = mockComplete.mock.calls[0][0].messages[0].content as string;
    /* A financials tool proposed to a sales role and then withdrawn is worse
       than one never mentioned. */
    expect(prompt).not.toContain("get_financials_metric");
  });

  it("offers more to a senior role", async () => {
    await run("cto");
    const seniorPrompt = mockComplete.mock.calls[0][0].messages[0].content as string;
    jest.clearAllMocks();
    mockComplete.mockResolvedValue({ content: "{}" });
    await run("viewer");
    const juniorPrompt = mockComplete.mock.calls[0][0].messages[0].content as string;
    expect(seniorPrompt.length).toBeGreaterThan(juniorPrompt.length);
  });

  it("never offers itself", async () => {
    await run();
    const prompt = mockComplete.mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toContain("plan_my_day:");
  });

  it("uses the cheap tier, because splitting prose is not reasoning", async () => {
    await run();
    expect(mockComplete.mock.calls[0][0].model_tier).toBe("cheap");
  });
});

describe("the answer", () => {
  it("separates what it can do from what is theirs", async () => {
    const res = await run();
    if (!res.ok) throw new Error("expected success");
    expect(res.data.covered).toBeGreaterThan(0);
    expect(res.data.humanOnly).toBe(1);
    expect(res.answer).toMatch(/Rehearse the client pitch out loud\*\* — yours/);
  });

  it("offers to chain when there is a chain worth building", async () => {
    const res = await run();
    if (!res.ok) throw new Error("expected success");
    expect(res.data.canChain).toBe(true);
    expect(res.answer).toMatch(/chain the parts I can do into one command/i);
  });

  /* THE BUG THIS CLOSES. The offer used to go out whether or not the pending
     row had been written, so "yes" landed on nothing and the person was told
     the assistant had lost the thread of the conversation they were in the
     middle of. An offer nothing can answer is worse than no offer: it costs
     them a reply and teaches them the chain-building does not work. */
  it("does not offer to chain when the offer could not be saved", async () => {
    mockSavePending.mockResolvedValue({ id: "error-1", description: "d", saved: false });
    const res = await run();
    if (!res.ok) throw new Error("expected success");
    expect(res.data.canChain).toBe(false);
    expect(res.answer).not.toMatch(/would you like me to/i);
    /* The plan itself still arrives. Losing the offer must not lose the work. */
    expect(res.answer).toMatch(/rehearse/i);
  });

  /* Somebody is about to read a dozen steps back before they answer. The
     five-minute window this defaults to was set for irreversible sends. */
  it("keeps the offer open long enough to read the plan", async () => {
    await run();
    expect(mockSavePending).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMinutes: 60 }),
    );
  });

  it("counts the gaps, which is the clearest statement of what to build next", async () => {
    mockComplete.mockResolvedValue({
      content: JSON.stringify({
        steps: [
          { text: "Check my calendar", tool: "calendar_widget" },
          { text: "Read email", tool: "search_mail" },
          { text: "Update the CRM in SAP", tool: "sap_update" },
        ],
      }),
    });
    const res = await run();
    if (!res.ok) throw new Error("expected success");

    /* ONE gap, and it is the only one that is a request for a new tool.
     *
     * WAS TWO. search_mail counted as a gap because its rule spans three
     * fields and fails at the root, so the planner had nothing to ask for.
     * That was a limitation of the planner rather than a fact about the
     * product, and it read to the user as "I cannot check your email" - the
     * commonest step anybody describes. Tools now name their own question
     * (ToolDef.chainAsk) and search_mail asks for a topic, so it is covered.
     *
     * SAP is the real gap: nothing behind it at all. Which is the number that
     * was always meant to say what to build next. */
    expect(res.data.gaps).toBe(1);
    expect(res.data.covered).toBe(2);
    expect(res.answer).toMatch(/nothing here does this yet/i);
    /* And the mail step says where it will stop and turn to them. */
    expect(res.answer).toMatch(/I will ask you for the topic/i);
  });
});

describe("when the model cannot be reached", () => {
  it("answers with a sentence rather than an error", async () => {
    mockComplete.mockRejectedValue(new Error("provider down"));
    const res = await run();
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/one step at a time/i);
  });

  it("says it could not read the description rather than inventing one", async () => {
    mockComplete.mockResolvedValue({ content: "I'm not sure how to help with that." });
    const res = await run();
    if (!res.ok) throw new Error("expected success");
    expect(res.data.stepCount).toBe(0);
    expect(res.answer).toMatch(/could not pick out any distinct steps/i);
  });
});
