/**
 * The front door.
 *
 * day-plan.test.ts proves the mapping. This proves the tool spends a model call
 * only when there is something to work with, offers the model only what this
 * person may run, and degrades into a sentence rather than an error.
 */
import { planMyDayTool, matchPlanDayIntent } from "../plan-my-day-tool";

const mockComplete = jest.fn();
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

    /* TWO gaps, for two different reasons, and the answer distinguishes them.
       search_mail exists and cannot run without knowing whose mail or about
       what, so it is not a missing capability; SAP is genuinely absent. Both
       count toward what to build next, and only one is a request for a new
       tool. */
    expect(res.data.gaps).toBe(2);
    expect(res.data.covered).toBe(1);
    expect(res.answer).toMatch(/nothing here does this yet/i);
    /* The schema's own words, which say more than ours did: a rule spanning
       several fields cannot become one question, and "needs at least one of
       from, to, or topic" tells somebody exactly what to type instead. */
    expect(res.answer).toMatch(/at least one of 'from', 'to', or 'topic'/);
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
