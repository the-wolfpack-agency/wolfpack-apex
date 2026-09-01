/**
 * The shipped routines.
 *
 * THE TEST THAT EARNS ITS PLACE is the last one: every tool a routine names
 * must exist, and the parameters it carries must pass that tool's OWN zod
 * schema. A routine is a promise that a chain will run; without this, the
 * promise is checked for the first time by a person who typed "run my
 * morning" and got a failure at step three.
 */
import { BUILT_IN_ROUTINES, matchRoutine, routineById } from "../catalog";
import { getToolByName } from "@/lib/assistant/tools/registry";
import "@/lib/assistant/tools";
import { referencedSlots } from "../slots";
import type { ToolStep, ModelStep } from "../types";

describe("matching what somebody typed", () => {
  it("matches an exact command", () => {
    expect(matchRoutine("run my morning")?.id).toBe("morning");
  });

  it("tolerates politeness and punctuation", () => {
    expect(matchRoutine("Please run my morning.")?.id).toBe("morning");
    expect(matchRoutine("can you run my morning?")?.id).toBe("morning");
  });

  /* A five-step chain that fires at somebody asking a question is much worse
     than one that failed to recognize its own name. */
  it("does not fire on a sentence that merely contains the command", () => {
    expect(matchRoutine("what happens when I run my morning routine")).toBeNull();
    expect(matchRoutine("should I run my morning before standup")).toBeNull();
  });

  it("does not fire on an empty or unrelated message", () => {
    expect(matchRoutine("")).toBeNull();
    expect(matchRoutine("what is the weather")).toBeNull();
  });

  /* js/polynomial-redos, found by CodeQL on this function. It reads whatever
     somebody typed, so a quantifier anchored at the end of the string was
     reachable input. The scan that replaced it is linear; this fails by
     timing out if a regex ever comes back. */
  it("does not slow down on a long run of punctuation", () => {
    const start = Date.now();
    expect(matchRoutine(`run my morning${"!".repeat(50_000)}`)).toBeNull();
    expect(matchRoutine("!".repeat(50_000))).toBeNull();
    expect(Date.now() - start).toBeLessThan(250);
  });

  it("ignores a message far longer than any command", () => {
    expect(matchRoutine("run my morning".padEnd(500, " "))).toBeNull();
  });

  it("finds a routine by id", () => {
    expect(routineById("weekly_review")?.command).toBe("weekly review");
    expect(routineById("nope")).toBeNull();
  });
});

describe("the shape every shipped routine keeps", () => {
  it("gives each routine a unique id and command", () => {
    const ids = BUILT_IN_ROUTINES.map((r) => r.id);
    const commands = BUILT_IN_ROUTINES.map((r) => r.command);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("ends every routine with a person, or with a step that asks for one", () => {
    /* Nothing ships that sends, files or tells anybody anything on its own. */
    for (const r of BUILT_IN_ROUTINES) {
      const last = r.steps[r.steps.length - 1];
      const isHuman = last.kind === "human";
      const isFormTool = last.kind === "tool" && last.tool.endsWith("_form");
      expect(isHuman || isFormTool).toBe(true);
    }
  });

  it("never reads a slot before some earlier step has written it", () => {
    /* The failure this prevents is only visible at run time otherwise, and
       only on the branch of the day that reaches that step. */
    for (const r of BUILT_IN_ROUTINES) {
      const written = new Set<string>();
      r.steps.forEach((step, i) => {
        const reads =
          step.kind === "tool"
            ? referencedSlots((step as ToolStep).params)
            : step.kind === "model"
              ? referencedSlots((step as ModelStep).prompt)
              : (step.show ?? []);
        for (const slot of reads) {
          expect({ routine: r.id, step: i, slot, written: [...written] }).toEqual(
            expect.objectContaining({ slot }),
          );
          expect(written.has(slot)).toBe(true);
        }
        if (step.kind !== "human" && step.slot) written.add(step.slot);
      });
    }
  });

  it("labels every step in words a person can read while waiting", () => {
    for (const r of BUILT_IN_ROUTINES) {
      for (const step of r.steps) {
        expect(step.label.length).toBeGreaterThan(8);
        expect(step.label).not.toMatch(/^[a-z_]+$/);
      }
    }
  });
});

describe("every step is backed by a tool that exists, with parameters it accepts", () => {
  it.each(BUILT_IN_ROUTINES.map((r) => [r.id, r] as const))("%s runs against the real registry", (_id, routine) => {
    for (const step of routine.steps) {
      if (step.kind !== "tool") continue;
      const tool = getToolByName(step.tool);
      expect({ step: step.label, tool: step.tool, found: Boolean(tool) }).toEqual(
        expect.objectContaining({ found: true }),
      );

      /* Parameters carrying no slot reference must satisfy the tool TODAY.
         Steps that interpolate are checked at run time, once the slot exists. */
      if (referencedSlots(step.params).length === 0) {
        const parsed = tool!.paramSchema.safeParse(step.params);
        expect({
          step: step.label,
          tool: step.tool,
          ok: parsed.success,
          issues: parsed.success ? [] : parsed.error.issues.map((i) => i.message),
        }).toEqual(expect.objectContaining({ ok: true }));
      }
    }
  });
});
