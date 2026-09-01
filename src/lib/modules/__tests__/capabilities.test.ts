/**
 * A contract nobody verifies becomes marketing inside a week.
 *
 * This file exists so the declaration cannot say "we support summarize" while
 * summarize returns a list. Without that, the capability registry becomes a
 * second place where the truth is not, and the drift it was built to prevent
 * happens inside the thing preventing it.
 *
 * The measurements it is checked against, taken on the live deployment
 * 2026-08-29:
 *
 *   ASK       "what are the payment terms in our SOW?"     -> answer + citation
 *   FIND      "what documents do we have about onboarding"  -> browsable list
 *   SUMMARIZE "summarize the onboarding document"           -> browsable list
 */
import {
  MODULE_CAPABILITIES,
  offerableActions,
  divergentActions,
  declaredSources,
} from "@/lib/modules/capabilities";
import { PROMPT_REQUIREMENTS } from "@/lib/assistant/welcome-prompts";
import { matchDocumentQuestion } from "@/lib/assistant/tools/search";

describe("the declaration must be honest", () => {
  /* THE ASSERTION THE WHOLE FILE IS FOR. An action claiming to be supported
     must return the shape its verb implies. "Summarize" that returns a list is
     not a supported summarize, whatever the registry says. */
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

  /* Records the measured state of documents. If summarize is ever fixed, this
     test fails and forces the registry to be updated in the same change, which
     is the point: the contract cannot lag the engine. */
  /* SUMMARIZE WAS THE GAP THIS FILE WAS BUILT AROUND, and it closed on
     2026-08-30. It spent two attempts as `routes_elsewhere`, which was the
     contract working: the first fix shipped, made things worse, and this
     declaration never claimed otherwise.
     Retained as an assertion rather than deleted, because the failure mode it
     guards is a summarize that quietly goes back to returning a list. */
  it("records that summarize now answers from the document", () => {
    const summarize = MODULE_CAPABILITIES.flatMap((m) => m.actions).find(
      (a) => a.id === "documents.summarize",
    )!;
    expect(summarize.status).toBe("supported");
    expect(summarize.returns).toBe("synthesised");
    /* behavesLike described the DETOUR. There is no longer one to describe. */
    expect(summarize.behavesLike).toBeUndefined();
  });
});

describe("what the interface may offer", () => {
  /* THE RULE THAT PREVENTS THE ORIGINAL DEFECT. The interface offered
     "summarize" and the engine returned a list. Only supported actions are
     offerable, so that cannot be built again by accident. */
  it("offers only supported actions", () => {
    for (const a of offerableActions("documents")) {
      expect(`${a.id}: ${a.status}`).toBe(`${a.id}: supported`);
    }
  });

  it("offers summarize, now that it summarizes", () => {
    expect(offerableActions("documents").map((a) => a.id)).toContain("documents.summarize");
  });

  /* THE WALKTHROUGH IS NOW THREE MOVES WIDE, not two. That is the whole point
     of the change: a client who asks a document a question, asks for a list,
     and asks for a summary gets three appropriately shaped answers. */
  it("offers the three that work", () => {
    expect(offerableActions("documents").map((a) => a.id).sort()).toEqual([
      "documents.ask",
      "documents.find",
      "documents.summarize",
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

  /* EVERY SYNTHESISED EXAMPLE MUST ACTUALLY REACH THE PATH THAT SYNTHESISES.
   *
   * This asserted that the example ended in a question mark, on the measured
   * rule that document COMMANDS routed to search and returned a list, so a
   * command could not produce the shape it claimed. That premise expired on
   * 2026-08-30: "summarize the onboarding document" is a command, is no longer
   * claimed by search, and now synthesises.
   *
   * Replaced rather than relaxed, and with something stricter. Punctuation was
   * only ever a proxy for the real property, which is that the example reaches
   * retrieval instead of being intercepted by a tool that returns a list. That
   * is checkable directly, and unlike the proxy it stays true when somebody
   * rewords an example. */
  it("routes every synthesised action's example to retrieval, not to a list", () => {
    for (const a of all.filter((x) => x.returns === "synthesised")) {
      const claimed = matchDocumentQuestion(a.example);
      expect(`${a.id} claimed by search: ${claimed !== null}`).toBe(
        `${a.id} claimed by search: false`,
      );
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
     here under names nothing else recognizes. */
  it("uses only source names the rest of the product knows", () => {
    for (const s of declaredSources()) {
      expect((PROMPT_REQUIREMENTS as readonly string[]).includes(s)).toBe(true);
    }
  });

  it("declares documents, the Phase 1 module", () => {
    expect(declaredSources()).toContain("documents");
  });
});
