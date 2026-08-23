/**
 * A guard over every path that can put a step into somebody's chain.
 *
 * THE CLASS OF BUG THIS CLOSES, found in production on 2026-08-23: a saved
 * chain contained a step whose tool requires a detail before it can do
 * anything, carrying no parameters, so it failed at step one with a validation
 * message about the tool rather than about the chain.
 *
 * Three separate places build a tool step with empty parameters, and each had
 * to learn the same lesson independently: the day mapper, the repair engine,
 * and the editor. This asserts the property for all of them at once, so a
 * fourth path added later fails here rather than in front of somebody at 8am.
 *
 * The property: A STEP THAT CANNOT RUN MUST NEVER REACH A CHAIN.
 */
import { mapDay, draftRoutine } from "../day-plan";
import { readRepair, checkRoutine } from "../heal";
import { replaceTool } from "../edit";
import { ROUTINE_TEMPLATES } from "../templates";
import { BUILT_IN_ROUTINES } from "../catalogue";
import { getTools } from "@/lib/assistant/tools/registry";
import "@/lib/assistant/tools";
import type { Routine } from "../types";

const tools = getTools();

/** Tools that genuinely cannot run on their own, read from their real schemas. */
const NEEDS_DETAIL = tools.filter((t) => !t.paramSchema.safeParse({}).success).map((t) => t.name);

describe("the registry actually contains tools that need a detail", () => {
  it("finds at least one, so this suite is not vacuous", () => {
    /* If this ever empties, these tests would pass while asserting nothing. */
    expect(NEEDS_DETAIL.length).toBeGreaterThan(0);
    expect(NEEDS_DETAIL).toContain("search_mail");
  });
});

describe("no path can put an unrunnable step into a chain", () => {
  it("the day mapper turns one into a gap", () => {
    for (const name of NEEDS_DETAIL.slice(0, 5)) {
      const plan = mapDay([{ text: "Do the thing", tool: name, humanOnly: false }], tools, "cto");
      expect({ tool: name, kind: plan.steps[0]?.kind }).toEqual(
        expect.objectContaining({ kind: "gap" }),
      );
    }
  });

  it("a drafted routine never contains one", () => {
    const plan = mapDay(
      [
        { text: "Read the overnight email", tool: "search_mail", humanOnly: false },
        { text: "Check the calendar", tool: "calendar_widget", humanOnly: false },
        { text: "Look at my tasks", tool: "task_list_widget", humanOnly: false },
      ],
      tools,
      "cto",
    );
    const draft = draftRoutine(plan, "d", "run my day");
    expect(draft).not.toBeNull();
    for (const step of draft!.steps) {
      if (step.kind !== "tool") continue;
      expect({ tool: step.tool, needsDetail: NEEDS_DETAIL.includes(step.tool) }).toEqual(
        expect.objectContaining({ needsDetail: false }),
      );
    }
  });

  it("the repair engine will not propose one", () => {
    const problem = {
      stepIndex: 0,
      label: "Read the overnight email",
      kind: "tool_missing" as const,
      tool: "gone_tool",
      detail: "gone",
    };
    for (const name of NEEDS_DETAIL.slice(0, 5)) {
      const repair = readRepair(`{"tool":"${name}"}`, problem, tools, "cto");
      expect({ tool: name, action: repair.action }).toEqual(
        expect.objectContaining({ action: "drop_step" }),
      );
    }
  });

  it("the editor will not swap one in", () => {
    const routine: Routine = {
      id: "r",
      command: "run my day",
      description: "d",
      audience: "anyone",
      steps: [{ kind: "tool", tool: "calendar_widget", params: { month: "current" }, label: "Calendar" }],
    };
    for (const name of NEEDS_DETAIL.slice(0, 5)) {
      const res = replaceTool(routine, 1, name, tools, "cto");
      expect({ tool: name, ok: res.ok }).toEqual(expect.objectContaining({ ok: false }));
    }
  });
});

describe("everything we ship already satisfies it", () => {
  it.each(BUILT_IN_ROUTINES.map((r) => [r.command, r] as const))("%s runs", (_c, routine) => {
    expect(checkRoutine(routine, tools, "cto").problems).toEqual([]);
  });

  it.each(ROUTINE_TEMPLATES.map((t) => [t.command, t] as const))("%s runs", (_c, template) => {
    expect(checkRoutine(template, tools, "cto").problems).toEqual([]);
  });
});
