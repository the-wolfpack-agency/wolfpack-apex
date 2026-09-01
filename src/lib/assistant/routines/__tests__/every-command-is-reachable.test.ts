/**
 * Every command the product offers must run when it is typed.
 *
 * On 2026-08-24 somebody typed "start my day" into the live assistant and got
 * back a chunk of a Porsche coaching CSV from the knowledge base. The command
 * was real. It is one of eleven templates, each carrying a `command` written
 * the way a person would say it, and matchRoutine only looked at the three
 * BUILT_IN_ROUTINES. The other eleven fell past every tool into the search
 * cascade, which answered a different question confidently.
 *
 * The distinction between a built-in routine and a template is ours: it
 * describes where a chain came from, not what it does, and nobody typing a
 * sentence could be expected to know it.
 *
 * This walks both libraries and requires each command to be reachable. Adding
 * a template with a name nobody can invoke now fails here rather than in front
 * of a customer.
 */
import { matchRoutine, BUILT_IN_ROUTINES } from "../catalog";
import { ROUTINE_TEMPLATES } from "../templates";

const ALL = [...BUILT_IN_ROUTINES, ...ROUTINE_TEMPLATES];

describe("every offered command is reachable from a message", () => {
  it("has commands in both libraries to check", () => {
    // If either list were empty this file would assert nothing, which is the
    // shape of failure it exists to catch.
    expect(BUILT_IN_ROUTINES.length).toBeGreaterThan(0);
    expect(ROUTINE_TEMPLATES.length).toBeGreaterThan(0);
  });

  it.each(ALL.map((r) => [r.command, r.id]))("%s", (command) => {
    const hit = matchRoutine(command as string);
    expect(hit).not.toBeNull();
    expect(hit?.command).toBe(command);
  });

  it("matches through the politeness people put around a request", () => {
    for (const wrapped of ["please start my day", "can you start my day", "Start My Day."]) {
      expect(matchRoutine(wrapped)?.command).toBe("start my day");
    }
  });

  it("no two commands collide", () => {
    // Two chains answering to the same words means one of them can never run,
    // and which one wins would be decided by array order.
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const r of ALL) {
      const prior = seen.get(r.command);
      if (prior) clashes.push(`${r.command}: ${prior} and ${r.id}`);
      else seen.set(r.command, r.id);
    }
    expect(clashes).toEqual([]);
  });
});

describe("a question is not a command", () => {
  /* The matcher stays exact. A five-step chain firing at somebody who asked a
     question is much worse than one that did not recognize its own name, and
     widening this to catch near misses would trade a visible failure for an
     invisible one. */
  it.each([
    "what changed in the pipeline last week and why",
    "can you tell me how to start my day off well",
    "the numbers are wrong",
    "start",
    "is anything on fire in the warehouse",
  ])("does not fire a chain at %j", (message) => {
    expect(matchRoutine(message)).toBeNull();
  });
});
