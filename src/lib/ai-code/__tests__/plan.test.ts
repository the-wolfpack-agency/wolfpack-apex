/**
 * Multi-step plan: deterministic parse + the non-throwing proposePlan with an
 * injected complete(). The plan is PROPOSE-ONLY - these tests assert it returns
 * text (steps), never executes, and degrades to an empty plan on any failure.
 */
import {
  composePlanPrompt,
  parsePlanResponse,
  proposePlan,
  MAX_PLAN_STEPS,
  type CompleteFn,
} from "@/lib/ai-code/plan";

const resp = (content: string) =>
  ({ content, model_used: "test-model", provider_used: "test" }) as never;

describe("composePlanPrompt", () => {
  test("includes context only when supplied", () => {
    expect(composePlanPrompt("add auth")).toBe("GOAL:\nadd auth");
    expect(composePlanPrompt("add auth", "repo x")).toContain("CONTEXT:\nrepo x");
  });
});

describe("parsePlanResponse", () => {
  test("parses a well-formed array into ordered, id'd steps", () => {
    const raw = JSON.stringify([
      { title: "Schema", instruction: "Add table", rationale: "foundation", sensitive: true },
      { title: "API", instruction: "Add route", rationale: "uses schema" },
    ]);
    const { steps, truncated } = parsePlanResponse(raw);
    expect(truncated).toBe(false);
    expect(steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
    expect(steps[0]).toMatchObject({ title: "Schema", instruction: "Add table", sensitive: true });
    expect(steps[1].sensitive).toBe(false); // missing -> false
  });

  test("extracts the array even when the model wraps it in prose/fences", () => {
    const raw = 'Here is the plan:\n```json\n[{"title":"A","instruction":"do a"}]\n```\nDone.';
    expect(parsePlanResponse(raw).steps).toHaveLength(1);
  });

  test("drops steps with no title or no instruction (not a real step)", () => {
    const raw = JSON.stringify([
      { title: "", instruction: "x" },
      { title: "y", instruction: "" },
      { title: "ok", instruction: "do ok" },
    ]);
    expect(parsePlanResponse(raw).steps.map((s) => s.title)).toEqual(["ok"]);
  });

  test("dedupes by normalized title", () => {
    const raw = JSON.stringify([
      { title: "Add cache", instruction: "a" },
      { title: "add cache", instruction: "b" },
    ]);
    expect(parsePlanResponse(raw).steps).toHaveLength(1);
  });

  test("caps at MAX_PLAN_STEPS and flags truncation", () => {
    const many = Array.from({ length: MAX_PLAN_STEPS + 3 }, (_, i) => ({ title: `t${i}`, instruction: `do ${i}` }));
    const { steps, truncated } = parsePlanResponse(JSON.stringify(many));
    expect(steps).toHaveLength(MAX_PLAN_STEPS);
    expect(truncated).toBe(true);
  });

  test("never throws on garbage -> empty plan", () => {
    expect(parsePlanResponse("not json at all").steps).toEqual([]);
    expect(parsePlanResponse("{not: an array}").steps).toEqual([]);
    expect(parsePlanResponse("").steps).toEqual([]);
    expect(parsePlanResponse('[{"title":"x"').steps).toEqual([]); // unterminated
  });
});

describe("proposePlan", () => {
  test("returns the parsed plan + model id", async () => {
    const complete: CompleteFn = async () =>
      resp(JSON.stringify([{ title: "One", instruction: "do one" }]));
    const plan = await proposePlan({ complete, goal: "big goal" });
    expect(plan.goal).toBe("big goal");
    expect(plan.steps).toHaveLength(1);
    expect(plan.model).toBe("test-model");
  });

  test("uses the cheap tier + confidential sensitivity (cost-first, zero-retention)", async () => {
    const complete = jest.fn<Promise<never>, [never]>(async () => resp("[]"));
    await proposePlan({ complete: complete as unknown as CompleteFn, goal: "g" });
    const req = (complete.mock.calls[0] as unknown[])[0] as { model_tier: string; sensitivity: string };
    expect(req.model_tier).toBe("cheap");
    expect(req.sensitivity).toBe("confidential");
  });

  test("empty goal short-circuits without calling the model", async () => {
    const complete = jest.fn();
    const plan = await proposePlan({ complete: complete as unknown as CompleteFn, goal: "   " });
    expect(plan.steps).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  test("never throws when the model call fails -> empty plan", async () => {
    const complete: CompleteFn = async () => { throw new Error("router down"); };
    const plan = await proposePlan({ complete, goal: "g" });
    expect(plan.steps).toEqual([]);
    expect(plan.model).toBeNull();
  });
});
