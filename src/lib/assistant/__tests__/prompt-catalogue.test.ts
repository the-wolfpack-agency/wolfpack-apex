/**
 * Every prompt in docs/assistant-prompts.md must actually work.
 *
 * A usage doc is the one kind of documentation that can be checked mechanically:
 * each example is an input, and the product either recognises it or does not.
 * Left unchecked it rots in the worst way, by telling somebody to type a
 * sentence that does nothing, on their first day, when they have no way to tell
 * whether they misunderstood or we did.
 *
 * So the doc is the fixture. Every fenced example is run through the same
 * matching the chat surface uses, and an example nothing claims fails here
 * rather than in front of a person.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getTools } from "@/lib/assistant/tools/registry";
import { matchRoutine } from "@/lib/assistant/routines/catalogue";
import "@/lib/assistant/tools";

const DOC = join(process.cwd(), "docs/assistant-prompts.md");

/** Every line inside a fenced block, which is where the examples live. */
function examplesFromDoc(): string[] {
  const text = readFileSync(DOC, "utf8");
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    const trimmed = line.trim();
    /* One example per line, which is also why the doc keeps the long day
       description on a single line: a wrapped example would be tested as two
       fragments, and neither fragment is what anybody types. */
    if (inFence && trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** Does anything in the product claim this message? */
function matchedBy(message: string): string | null {
  const routine = matchRoutine(message);
  if (routine) return `routine:${routine.id}`;
  for (const tool of getTools()) {
    try {
      if (tool.matchIntent?.(message) != null) return `tool:${tool.name}`;
    } catch {
      /* A matcher that throws is a separate failure, asserted below. */
    }
  }
  return null;
}

describe("the prompts we tell people to type", () => {
  const examples = examplesFromDoc();

  it("finds examples in the doc at all, so a rename cannot make this vacuous", () => {
    expect(examples.length).toBeGreaterThan(20);
  });

  it.each(examples.map((e) => [e]))("%s is recognised by something", (example) => {
    const match = matchedBy(example);
    expect({ example, match }).toEqual(expect.objectContaining({ match: expect.any(String) }));
  });
});

describe("the commands named in the doc's tables", () => {
  it.each([["run my morning"], ["where do things stand"], ["weekly review"]])(
    "%s is a real routine",
    (command) => {
      expect(matchRoutine(command)).not.toBeNull();
    },
  );

  it.each([["what can you do"]])("%s is a real tool", (command) => {
    expect(matchedBy(command)).toMatch(/^tool:/);
  });
});

describe("no matcher throws on ordinary text", () => {
  /* A matcher that throws would be caught and skipped above, hiding a broken
     tool behind a passing suite. */
  it.each([
    ["what can you do"],
    ["show me my tasks"],
    ["a sentence with (unbalanced parens and [brackets"],
    ["!!!!!!!!!!"],
  ])("%p", (message) => {
    for (const tool of getTools()) {
      expect(() => tool.matchIntent?.(message)).not.toThrow();
    }
  });
});
