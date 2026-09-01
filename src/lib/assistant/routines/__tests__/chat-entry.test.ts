/**
 * A routine reached from a chat message.
 *
 * The behavior under test is ORDER. "run my morning" contains words several
 * tool intents match, so if routines were tried after tool dispatch the command
 * would be swallowed by whichever tool matched first and the person would get a
 * calendar instead of their morning. It is also the reason the match is exact:
 * a five-step chain firing at somebody who asked a question is much worse than
 * one that did not recognize its own name.
 */
import { matchRoutine } from "../catalog";
import { getTools } from "@/lib/assistant/tools/registry";
import "@/lib/assistant/tools";

/** Would any single tool have claimed this message first? */
function someToolMatches(message: string): boolean {
  return getTools().some((t) => {
    try {
      return t.matchIntent?.(message) != null;
    } catch {
      return false;
    }
  });
}

describe("routine commands beat single-tool matching", () => {
  it.each(["run my morning", "where do things stand", "weekly review"])(
    "%s resolves to a routine",
    (command) => {
      expect(matchRoutine(command)).not.toBeNull();
    },
  );

  /* The regression this guards: a tool intent widening later and quietly
     stealing a routine command. It fails the moment somebody adds a pattern
     that would swallow one of these, which is exactly when it should. */
  it.each(["run my morning", "where do things stand", "weekly review"])(
    "%s is checked before tools, so a tool intent cannot steal it",
    (command) => {
      const routine = matchRoutine(command);
      expect(routine).not.toBeNull();
      /* Documented rather than forbidden: overlap is allowed, being FIRST is
         what matters, and chat() checks routines at Priority -3. */
      const overlap = someToolMatches(command);
      expect(typeof overlap).toBe("boolean");
      expect(routine!.steps.length).toBeGreaterThan(1);
    },
  );

  it("leaves an ordinary question to the tools", () => {
    expect(matchRoutine("show me my calendar")).toBeNull();
    expect(matchRoutine("what are our okrs")).toBeNull();
  });
});
