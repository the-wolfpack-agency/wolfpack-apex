/**
 * What a paused chain TELLS the person, and whether they can get back into it.
 *
 * Both of these came out of one real conversation against the deployed
 * assistant. A four-step chain said "1 of 4 steps done" after step one, the
 * person did step two and said done, and it said "1 of 4 steps done" again.
 * They did step three and it finished with "Done. 2 steps, 0s of work." Then
 * saying done once more got "That routine does not exist any more."
 *
 * Nothing was actually lost either time. The tally was counting machine steps
 * against a total that included human ones, and the resume lookup was reading
 * a list that the routine they ran was not in. But a person cannot see that,
 * and what they see is a chain that forgets their work and then denies it ever
 * existed. That is the thing worth a test.
 */
import { advance, resume, startRun, type RunnerDeps } from "../runner";
import { describeRun, routineById } from "../index";
import { ROUTINE_TEMPLATES } from "../templates";
import { BUILT_IN_ROUTINES } from "../catalog";
import type { Routine } from "../types";

const WHO = { runId: "run-1", userId: "u1", workspaceId: "w1" };

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    dispatchTool: async () => ({ ok: true, answer: "done", data: {} }),
    askModel: async () => "the model's answer",
    now: () => 0,
    ...over,
  };
}

/* THE EXACT SHAPE FROM THE CONVERSATION: machine, person, person, machine.
   Two human steps back to back is what made the stuck tally visible, because
   the count only moved on the steps it was willing to count. */
const FOUR_STEPS: Routine = {
  id: "t",
  command: "run my day",
  description: "t",
  audience: "anyone",
  steps: [
    { kind: "tool", tool: "a", params: {}, label: "Pull the calendar" },
    { kind: "human", label: "Rehearse the opening", action: "do" },
    { kind: "human", label: "Check the room is booked", action: "do" },
    { kind: "tool", tool: "b", params: {}, label: "File the notes" },
  ],
};

describe("the tally a paused chain shows", () => {
  it("moves when the person does the step they were asked to do", async () => {
    let run = await advance(FOUR_STEPS, startRun(FOUR_STEPS, WHO), deps());
    expect(run.state).toBe("waiting_for_human");
    expect(describeRun(FOUR_STEPS, run)).toContain("1 of 4 steps done");

    /* They did it. The next thing they read must not be the same number. */
    run = await resume(FOUR_STEPS, run, deps());
    expect(run.state).toBe("waiting_for_human");
    expect(describeRun(FOUR_STEPS, run)).toContain("2 of 4 steps done");
  });

  it("counts every step that happened when the chain finishes", async () => {
    let run = await advance(FOUR_STEPS, startRun(FOUR_STEPS, WHO), deps());
    run = await resume(FOUR_STEPS, run, deps());
    run = await resume(FOUR_STEPS, run, deps());

    expect(run.state).toBe("done");
    /* Four steps happened. Reporting two is the chain telling somebody their
       own work did not count. */
    expect(describeRun(FOUR_STEPS, run)).toContain("Done. 4 steps");
  });

  /* A SKIP IS NOT A DONE. The count has to stay honest in the other
     direction too, or "steps done" becomes "steps reached". */
  it("does not count a step the person skipped", async () => {
    let run = await advance(FOUR_STEPS, startRun(FOUR_STEPS, WHO), deps());
    run = await resume(FOUR_STEPS, run, deps(), { skipped: true });
    expect(describeRun(FOUR_STEPS, run)).toContain("1 of 4 steps done");
  });
});

describe("finding the routine a paused run belongs to", () => {
  /* THE BUG: routineById read the built-ins only, so a run of any of the
     eleven templates could be started and never finished. The resume path
     looks the id up through here, misses, and tells the person the routine is
     gone after they have already done the work. */
  it.each(ROUTINE_TEMPLATES.map((t) => [t.command, t.id]))(
    "%s can be found again by the id its run recorded",
    (_command, id) => {
      expect(routineById(id as string)?.id).toBe(id);
    },
  );

  it.each(BUILT_IN_ROUTINES.map((r) => [r.command, r.id]))(
    "%s can be found again by the id its run recorded",
    (_command, id) => {
      expect(routineById(id)?.id).toBe(id);
    },
  );

  it("still returns nothing for an id that is genuinely not ours", () => {
    expect(routineById("tmpl_not_a_real_routine")).toBeNull();
  });
});
