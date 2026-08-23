/**
 * Picking up a routine that was waiting on somebody.
 *
 * THE BUG THIS CLOSES: the product told people "Reply to carry on" and nothing
 * listened. Nothing in the codebase called resumeRoutine, so a chain that
 * stopped at a human step stopped forever, having asked for something it could
 * not receive. A promise in the product's own words that nothing implements is
 * worse than not making it.
 *
 * The two risks in fixing it are opposite, and both are tested here: swallowing
 * an unrelated message as an answer, and resuming a chain that cannot actually
 * finish because the values it needs were deliberately never stored.
 */
import { detectResumeIntent } from "../index";
import { referencedSlots } from "../slots";
import type { RoutineStep } from "../types";

describe("what counts as coming back", () => {
  it.each(["done", "carry on", "continue", "next", "Done.", "OK done"])(
    "%p means carry on",
    (m) => {
      expect(detectResumeIntent(m)).toBe("carry_on");
    },
  );

  it.each(["skip", "skip it", "not this time", "didn't do it"])("%p means skip", (m) => {
    expect(detectResumeIntent(m)).toBe("skip");
  });

  /* THE FAILURE MODE ON THE OTHER SIDE. Treating any message as the answer
     while a run is waiting means somebody asks about the weather and their
     chain quietly moves on instead. */
  it.each([
    "what's the weather",
    "show me my tasks",
    "I am done with this project",
    "can you skip the intro when you summarise",
    "yes",
  ])("%p is NOT a resume", (m) => {
    expect(detectResumeIntent(m)).toBe("none");
  });

  it("ignores trailing punctuation but not extra words", () => {
    expect(detectResumeIntent("done!!")).toBe("carry_on");
    expect(detectResumeIntent("done with the report")).toBe("none");
  });

  it("is not confused by an empty message", () => {
    expect(detectResumeIntent("")).toBe("none");
    expect(detectResumeIntent("   ")).toBe("none");
  });
});

describe("what counts as a slot the resumed run cannot have", () => {
  /* THE BUG THIS CLOSES, found by running an asking chain against production:
     answer the question, and be told the chain cannot continue because a later
     step reads what an earlier step produced. The steps that fill those slots
     had not run yet. They were the next thing to happen. */
  const reads = (step: RoutineStep): string[] =>
    step.kind === "tool"
      ? referencedSlots(step.params)
      : step.kind === "model"
        ? referencedSlots(step.prompt)
        : [];

  /** The check as it now stands: walk in order, tracking what gets written. */
  function firstUnwritten(remaining: RoutineStep[]): string | null {
    const willWrite = new Set<string>();
    for (const step of remaining) {
      for (const slot of reads(step)) if (!willWrite.has(slot)) return slot;
      if (step.kind !== "human" && step.slot) willWrite.add(step.slot);
    }
    return null;
  }

  it("does not complain when the steps about to run will write it", () => {
    /* A chain paused BEFORE its gathering: the whole point of resuming is that
       the gathering happens now. */
    const remaining: RoutineStep[] = [
      { kind: "tool", tool: "crm", params: {}, slot: "record", label: "Find them" },
      { kind: "tool", tool: "mail", params: {}, slot: "mail", label: "Find the mail" },
      { kind: "model", prompt: "{{record}} and {{mail}}", label: "Read both" },
    ];
    expect(firstUnwritten(remaining)).toBeNull();
  });

  it("still complains when nothing left will write it", () => {
    /* A chain paused AFTER its gathering, which is the case the original check
       was written for and got right. */
    const remaining: RoutineStep[] = [
      { kind: "model", prompt: "summarise {{inbox}}", label: "Summarise" },
    ];
    expect(firstUnwritten(remaining)).toBe("inbox");
  });

  it("names the FIRST slot that cannot be filled, in order", () => {
    const remaining: RoutineStep[] = [
      { kind: "tool", tool: "crm", params: {}, slot: "record", label: "Find them" },
      { kind: "model", prompt: "{{record}} then {{gone}}", label: "Read" },
    ];
    expect(firstUnwritten(remaining)).toBe("gone");
  });

  it("does not treat a human step's show list as a read it must satisfy", () => {
    /* A human step shows what it has. It is not a dependency that can break a
       chain, and treating it as one would refuse resumes that are fine. */
    const remaining: RoutineStep[] = [
      { kind: "human", label: "Look at this", action: "review", show: ["anything"] },
    ];
    expect(firstUnwritten(remaining)).toBeNull();
  });
});
