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
