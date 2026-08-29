/**
 * A contract nobody verifies becomes marketing inside a week.
 *
 * This file exists so the declaration cannot say "we support summarise" while
 * summarise returns a list. Without that, the capability registry becomes a
 * second place where the truth is not, and the drift it was built to prevent
 * happens inside the thing preventing it.
 *
 * The measurements it is checked against, taken on the live deployment
 * 2026-08-29:
 *
 *   ASK       "what are the payment terms in our SOW?"     -> answer + citation
 *   FIND      "what documents do we have about onboarding"  -> browsable list
 *   SUMMARISE "summarize the onboarding document"           -> browsable list
 */
import {
  MODULE_CAPABILITIES,
  offerableActions,
  divergentActions,
  declaredSources,
} from "@/lib/modules/capabilities";
import { PROMPT_REQUIREMENTS } from "@/lib/assistant/welcome-prompts";

describe("the declaration must be honest", () => {
  /* THE ASSERTION THE WHOLE FILE IS FOR. An action claiming to be supported
     must return the shape its verb implies. "Summarise" that returns a list is
     not a supported summarise, whatever the registry says. */
  it("never marks an action supported when it behaves like another one", () => {
    for (const m of MODULE_CAPABILITIES) {
      for (const a of m.actions) {
        const inconsistent = a.status === "supported" && a.behavesLike !== undefined;
        expect(`${a.id}: supported-but-routes-elsewhere = ${inconsistent}`).toBe(
          `${a.id}: supported-but-routes-elsewhere = false`,
        );
      }
    }
  });

  /* A divergence has to say where it goes, or it is a complaint rather than a
     record somebody can act on. */
  it("makes every divergent action name what it actually behaves like", () => {
    for (const a of divergentActions()) {
      expect(`${a.id}: ${typeof a.behavesLike}`).toBe(`${a.id}: string`);
      const target = MODULE_CAPABILITIES.flatMap((m) => m.actions).find(
        (x) => x.id === a.behavesLike,
      );
      expect(`${a.id} -> ${a.behavesLike}: ${target !== undefined}`).toBe(
        `${a.id} -> ${a.behavesLike}: true`,
      );
    }
  });

  /* Records the measured state of documents. If summarise is ever fixed, this
     test fails and forces the registry to be updated in the same change, which
     is the point: the contract cannot lag the engine. */
  it("records that summarise currently behaves like find", () => {
    const summarise = MODULE_CAPABILITIES.flatMap((m) => m.actions).find(
      (a) => a.id === "documents.summarise",
    )!;
    expect(summarise.status).toBe("routes_elsewhere");
    expect(summarise.behavesLike).toBe("documents.find");
  });
});

describe("what the interface may offer", () => {
  /* THE RULE THAT PREVENTS THE ORIGINAL DEFECT. The interface offered
     "summarise" and the engine returned a list. Only supported actions are
     offerable, so that cannot be built again by accident. */
  it("offers only supported actions", () => {
    for (const a of offerableActions("documents")) {
      expect(`${a.id}: ${a.status}`).toBe(`${a.id}: supported`);
    }
  });

  it("does not offer summarise while it behaves like find", () => {
    expect(offerableActions("documents").map((a) => a.id)).not.toContain("documents.summarise");
  });

  it("still offers the two that work", () => {
    expect(offerableActions("documents").map((a) => a.id).sort()).toEqual([
      "documents.ask",
      "documents.find",
    ]);
  });

  it("returns nothing for a source with no declared module yet", () => {
    expect(offerableActions("financials")).toEqual([]);
  });
});

describe("every action is usable as an interface entry", () => {
  const all = MODULE_CAPABILITIES.flatMap((m) => m.actions);

  it("gives each one a unique id", () => {
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
  });

  /* The example is what gets shown and typed, so it has to be a phrasing
     measured to produce the declared shape, not a description of one. */
  it.each(["id", "verb", "example", "because"] as const)("gives each one a %s", (field) => {
    for (const a of all) {
      expect(`${a.id}.${field}: ${String(a[field] ?? "").length > 2}`).toBe(
        `${a.id}.${field}: true`,
      );
    }
  });

  /* A synthesised answer comes from asking a question. The measured rule is
     that document COMMANDS route to search and return a list, so an example
     phrased as a command could not produce the shape it claims. */
  it("phrases every synthesised action's example as a question", () => {
    for (const a of all.filter((x) => x.returns === "synthesised")) {
      expect(`${a.id}: ${a.example.trim().endsWith("?")}`).toBe(`${a.id}: true`);
    }
  });

  /* Examples get typed into a client's deployment, where our documents do not
     exist. */
  it("uses no example that only our corpus can answer", () => {
    for (const a of all) {
      expect(`${a.id}: ${/\bSOW\b|viaPeople|wolfpack/i.test(a.example)}`).toBe(`${a.id}: false`);
    }
  });
});

describe("the registry scales to the modules coming next", () => {
  /* Sources come from PROMPT_REQUIREMENTS so DMS and CRM cannot be declared
     here under names nothing else recognises. */
  it("uses only source names the rest of the product knows", () => {
    for (const s of declaredSources()) {
      expect((PROMPT_REQUIREMENTS as readonly string[]).includes(s)).toBe(true);
    }
  });

  it("declares documents, the Phase 1 module", () => {
    expect(declaredSources()).toContain("documents");
  });
});
