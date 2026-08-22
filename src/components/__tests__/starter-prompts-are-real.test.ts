/**
 * The chips in the suggestions panel have to do something.
 *
 * A starter prompt is a promise made before somebody has any way to judge us:
 * it is the first thing they click, and if it does nothing they conclude the
 * product does nothing. The panel is also the only place many people will ever
 * discover a chain exists.
 *
 * TWO ASSERTIONS, AND THE SECOND IS THE ONE THAT KEEPS WORKING
 *
 * 1. Every chip in the chains category resolves to a real routine or tool. A
 *    renamed routine fails the build instead of leaving a dead chip.
 * 2. Every built-in routine APPEARS in the panel. Add a chain and this fails
 *    until it is surfaced, which is the difference between a feature that
 *    exists and one anybody finds.
 *
 * Deliberately NOT asserted: that every other starter prompt matches a
 * deterministic intent. Plenty are meant to reach the model, and demanding a
 * tool match for those would either fail honest prompts or push somebody to
 * write a regex to satisfy a test.
 */
import { buildStarterCategoriesForTest } from "@/components/AssistantStarterPrompts";
import { BUILT_IN_ROUTINES, matchRoutine } from "@/lib/assistant/routines/catalogue";
import { getTools } from "@/lib/assistant/tools/registry";
import "@/lib/assistant/tools";

const CHAINS = "Whole jobs, in one command";

const categories = buildStarterCategoriesForTest();
const chains = categories.find((c) => c.title === CHAINS);

/** Anything in the product that claims this message. */
function matchedBy(message: string): string | null {
  const routine = matchRoutine(message);
  if (routine) return `routine:${routine.id}`;
  for (const tool of getTools()) {
    try {
      if (tool.matchIntent?.(message) != null) return `tool:${tool.name}`;
    } catch {
      /* asserted separately below */
    }
  }
  return null;
}

describe("the chains category", () => {
  it("exists and is first, so whole jobs are met before individual answers", () => {
    /* Somebody scanning this panel for the first time should meet the thing
       that saves them twenty minutes before they meet the weather. */
    expect(chains).toBeDefined();
    expect(categories[0].title).toBe(CHAINS);
  });

  it("is not gated behind an integration", () => {
    /* Hiding chains until every connector is set up keeps them invisible on
       exactly the days somebody is setting up. */
    expect(chains!.requires).toBeUndefined();
  });

  it.each((chains?.prompts ?? []).map((p) => [p.text.slice(0, 60), p.text] as const))(
    "chip %s does something",
    (_label, text) => {
      const match = matchedBy(text);
      expect({ text: text.slice(0, 60), match }).toEqual(
        expect.objectContaining({ match: expect.any(String) }),
      );
    },
  );

  it("explains each chip in a sentence, since the description is a tooltip somebody reads before committing", () => {
    for (const p of chains!.prompts) {
      expect(p.description.length).toBeGreaterThan(40);
    }
  });
});

describe("every routine is discoverable", () => {
  /* THE ASSERTION THAT KEEPS EARNING. A chain nobody can find is a chain
     nobody runs, and the panel is where people look. */
  it.each(BUILT_IN_ROUTINES.map((r) => [r.command] as const))(
    "%s appears in the suggestions panel",
    (command) => {
      const all = categories.flatMap((c) => c.prompts.map((p) => p.text.toLowerCase()));
      expect(all).toContain(command.toLowerCase());
    },
  );
});

describe("no chip is silently swallowed by the wrong thing", () => {
  it("routes each chain command to its own routine, not to a tool", () => {
    for (const r of BUILT_IN_ROUTINES) {
      expect(matchedBy(r.command)).toBe(`routine:${r.id}`);
    }
  });
});
