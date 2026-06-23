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
