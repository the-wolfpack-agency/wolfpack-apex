/**
 * What a client-facing role can actually reach.
 *
 * THE MEASUREMENT THAT PROMPTED THIS. Every role, from cto down to viewer,
 * could invoke 58 of 60 tools, because 46 of them declare capability "*" and
 * the rank gate returns true immediately for that. Scoping by role was a claim
 * about a mechanism nothing was using.
 *
 * A dealer does not need the financials tools withheld on security grounds.
 * They need them absent: a menu of 58 capabilities where six are theirs is not
 * a product they can use, and every irrelevant tool is one more thing a phrase
 * can be matched against wrongly.
 */
import "@/lib/assistant/tools/index";
import { getTools } from "@/lib/assistant/tools/registry";
import { canInvokeNamedTool } from "@/lib/assistant/tools/gate";
import { TOOL_PERSONAS, hasPersona, personaAllows } from "@/lib/assistant/tools/persona";

const reachable = (role: string) =>
  getTools().filter((t) => canInvokeNamedTool(role, t.name, t.capability)).map((t) => t.name);

describe("a persona is a curated surface", () => {
  it("gives a dealer a handful of tools, not the whole registry", () => {
    const n = reachable("dealer").length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(TOOL_PERSONAS.dealer.length);
    /* The number that makes it a product rather than a menu. */
    expect(n).toBeLessThan(15);
  });

  it("gives a Center manager more than a dealer, and still not everything", () => {
    expect(reachable("dealer_manager").length).toBeGreaterThan(reachable("dealer").length);
    expect(reachable("dealer_manager").length).toBeLessThan(getTools().length);
  });

  /* THE POINT OF THE WHOLE DESIGN: nothing moves for anybody who has no
     persona, which is every internal role today. */
  it("leaves internal roles exactly as they were", () => {
    expect(reachable("cto").length).toBe(getTools().length);
    expect(reachable("sales").length).toBeGreaterThan(50);
    expect(hasPersona("sales")).toBe(false);
  });

  /* A curated surface that grows whenever somebody registers a tool is not
     curated. Adding a dealer capability should be a review, not an accident. */
  it("does not admit a tool added tomorrow", () => {
    expect(personaAllows("dealer", "some_tool_added_next_week")).toBe(false);
    expect(personaAllows("sales", "some_tool_added_next_week")).toBe(true);
  });

  it("refuses a dealer the tools that are not their business", () => {
    for (const name of ["financial_metrics", "search_github_issues", "log_time"]) {
      expect(personaAllows("dealer", name)).toBe(false);
    }
  });
});

describe("a persona cannot name a tool that does not exist", () => {
  /* A misspelled or renamed entry is a silent hole: the persona looks curated
     and quietly grants nothing. Found exactly this way - "search_brain" was in
     both lists and is not a registered tool. */
  it.each(Object.keys(TOOL_PERSONAS))("every tool named by %s is real", (persona) => {
    const names = new Set(getTools().map((t) => t.name));
    const missing = TOOL_PERSONAS[persona].filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });
});

describe("the menu and the runtime agree", () => {
  /* A list that offers what the dispatcher will refuse is a menu of
     disappointments, and the two are separate call sites that can drift. */
  it("what_can_you_do is reachable by a dealer, since it is their way in", () => {
    expect(personaAllows("dealer", "what_can_you_do")).toBe(true);
  });
});

/* ---------------------------------------------------------------------
 * The first screen a dealer ever sees, in their language.
 *
 * Scoping made the surface the right size and left it in the wrong words. The
 * most important capability a dealer has read:
 *
 *   Everything else
 *   - Drive the dealer's DMS web UI (via the AgenticQA browser-driver bridge)
 *     to fetch and render vehicle inventory matching the user's filters
 *
 * Every word of that is about our architecture, filed under a heading that
 * says it does not matter. Somebody deciding whether this product is worth
 * their time learns that it is not for them, and they are right to.
 * --------------------------------------------------------------- */
import { personaCopyFor, PERSONA_COPY } from "@/lib/assistant/tools/persona";

describe("client-facing copy", () => {
  it("describes a dealer's vehicles in their terms, not ours", () => {
    const copy = personaCopyFor("dealer", "dms_inventory_widget");
    expect(copy?.area).toBe("Your demo vehicles");
    expect(copy?.description ?? "").not.toMatch(/AgenticQA|browser-driver|widget|render/i);
  });

  /* Internal roles keep the registry's own wording, which is right for them. */
  it("leaves roles without a persona on the tool's own description", () => {
    expect(personaCopyFor("cto", "dms_inventory_widget")).toBeNull();
  });

  /* A tool with no entry falls back rather than disappearing: nothing should
     be hidden by an omission in a copy map. */
  it("falls back for a tool nobody has written copy for", () => {
    expect(personaCopyFor("dealer", "some_unwritten_tool")).toBeNull();
  });

  it("says nothing about how it works", () => {
    for (const [name, copy] of Object.entries(PERSONA_COPY)) {
      expect({ name, leaks: /API|endpoint|widget|bridge|Graph|SDK|payload/i.test(copy.description) })
        .toEqual({ name, leaks: false });
    }
  });

  /* Copy is only useful if it covers what a persona actually exposes. */
  it("covers every tool the dealer persona shows them", () => {
    /* what_can_you_do is the tool answering the question and excludes itself
       from its own list, so it never needs a line of copy. Everything a dealer
       actually reads does. */
    const uncovered = TOOL_PERSONAS.dealer
      .filter((n) => n !== "what_can_you_do")
      .filter((n) => !PERSONA_COPY[n]);
    expect(uncovered).toEqual([]);
  });
});
