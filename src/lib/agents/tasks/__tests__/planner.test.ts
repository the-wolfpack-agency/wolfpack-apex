import { IntentPlanner, MAX_TASK_STEPS } from "@/lib/agents/tasks/planner";

const planner = new IntentPlanner();

describe("IntentPlanner", () => {
  it("splits a numbered list into ordered steps, stripping markers", () => {
    expect(planner.plan("1. get the weather\n2. summarize feedback")).toEqual([
      "get the weather",
      "summarize feedback",
    ]);
  });
  it("handles bullets and parenthesized numbers", () => {
    expect(planner.plan("- do A\n* do B\n3) do C")).toEqual(["do A", "do B", "do C"]);
  });
  it("treats a single instruction as one step", () => {
    expect(planner.plan("show my calendar")).toEqual(["show my calendar"]);
  });
  it("drops empty lines", () => {
    expect(planner.plan("do A\n\n\ndo B")).toEqual(["do A", "do B"]);
  });
  it("caps the plan at the step backstop", () => {
    const goal = Array.from({ length: 20 }, (_, i) => `step ${i}`).join("\n");
    expect(planner.plan(goal)).toHaveLength(MAX_TASK_STEPS);
  });
});

describe("IntentPlanner - single-line multi-action decomposition", () => {
  it("splits a two-sentence run-on into two ordered steps", () => {
    expect(
      planner.plan(
        "scan the internet for the latest news on auto SAAS companies. Create a document summary of the results.",
      ),
    ).toEqual([
      "scan the internet for the latest news on auto SAAS companies.",
      "Create a document summary of the results.",
    ]);
  });

  it("splits on 'and then'", () => {
    expect(
      planner.plan("search the web for X and then summarize the results"),
    ).toEqual(["search the web for X", "summarize the results"]);
  });

  it("splits on a bare 'then'", () => {
    expect(planner.plan("get the weather then email the team")).toEqual([
      "get the weather",
      "email the team",
    ]);
  });

  it("keeps a single imperative as one step", () => {
    expect(planner.plan("show my calendar for tomorrow")).toEqual([
      "show my calendar for tomorrow",
    ]);
  });

  it("does NOT split inside a U.S.-style abbreviation", () => {
    expect(planner.plan("email the U.S. team about Q3")).toEqual([
      "email the U.S. team about Q3",
    ]);
  });

  it("does NOT split inside Inc./Corp./etc. abbreviations", () => {
    expect(
      planner.plan("research Acme Inc. and their competitors"),
    ).toEqual(["research Acme Inc. and their competitors"]);
    expect(planner.plan("look up Globex Corp. financials")).toEqual([
      "look up Globex Corp. financials",
    ]);
  });

  it("does NOT split inside e.g. / i.e.", () => {
    expect(
      planner.plan("summarize the doc, e.g. the key risks and timeline"),
    ).toEqual(["summarize the doc, e.g. the key risks and timeline"]);
  });

  it("does NOT split after a single-letter initial", () => {
    expect(planner.plan("message J. Smith about the contract")).toEqual([
      "message J. Smith about the contract",
    ]);
  });

  it("still splits a real boundary that follows an abbreviation-containing sentence", () => {
    expect(
      planner.plan(
        "email the U.S. team about Q3. Then draft the summary.",
      ),
    ).toEqual(["email the U.S. team about Q3.", "draft the summary."]);
  });

  it("still honors a numbered list (does not over-split each line)", () => {
    expect(
      planner.plan("1. scan the internet for news\n2. summarize the results"),
    ).toEqual(["scan the internet for news", "summarize the results"]);
  });

  it("caps a heavily-conjoined single line at the step backstop", () => {
    const line = Array.from({ length: 20 }, (_, i) => `do step ${i}`).join(
      " and then ",
    );
    expect(planner.plan(line)).toHaveLength(MAX_TASK_STEPS);
  });
});
