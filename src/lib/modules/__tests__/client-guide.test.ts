/**
 * The client's instructions must not promise what the engine will not do.
 *
 * A guide that teaches a phrasing the product does not honour is worse than no
 * guide: somebody follows it, gets a list where they expected an answer, and
 * concludes the tool is broken rather than that the sentence was wrong. That
 * failure already happened once here — the onboarding modal taught
 * "what do our documents say about X", which returns a result count, under a
 * description promising an answer with its source.
 *
 * So the guide is generated from the same declaration that decides what the
 * interface offers and what the deployment journey verifies. The three cannot
 * disagree.
 */
import {
  clientGuide,
  clientGuideMarkdown,
  operatorNotes,
} from "@/lib/modules/client-guide";
import { MODULE_CAPABILITIES } from "@/lib/modules/capabilities";

describe("the client guide teaches only what works", () => {
  const guide = clientGuide();

  it("includes every supported action and nothing else", () => {
    const taught = guide.flatMap((s) => s.entries.map((e) => e.say));
    const supported = MODULE_CAPABILITIES.flatMap((m) =>
      m.actions.filter((a) => a.status === "supported").map((a) => a.example),
    );
    expect(taught.sort()).toEqual(supported.sort());
  });

  /* THE ONE THAT MATTERS. summarize currently returns a list. Teaching it
     would send every client down the path that produced the original
     complaint. */
  it("never teaches an action that routes elsewhere", () => {
    const taught = new Set(guide.flatMap((s) => s.entries.map((e) => e.say)));
    for (const m of MODULE_CAPABILITIES) {
      for (const a of m.actions.filter((x) => x.status === "routes_elsewhere")) {
        expect(`teaches "${a.example}": ${taught.has(a.example)}`).toBe(
          `teaches "${a.example}": false`,
        );
      }
    }
  });

  /* These words go in front of somebody whose documents are their own. An
     example naming our SOW teaches nothing and looks like a mistake. */
  it("uses no example only our corpus can answer", () => {
    for (const s of guide) {
      for (const e of s.entries) {
        expect(`${e.say}: ${/\bSOW\b|viaPeople|wolfpack/i.test(e.say)}`).toBe(
          `${e.say}: false`,
        );
      }
    }
  });

  /* The reader has never seen our types and should not have to. */
  it("describes results in plain words, not internal shape names", () => {
    const md = clientGuideMarkdown();
    for (const jargon of ["synthesised", "routes_elsewhere", "AnswerShape", "capabilityTier"]) {
      expect(md).not.toContain(jargon);
    }
  });

  it("gives every entry something to type and something to expect", () => {
    for (const s of guide) {
      for (const e of s.entries) {
        expect(e.say.length).toBeGreaterThan(5);
        expect(e.get.length).toBeGreaterThan(10);
        expect(e.goal.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("the operator notes carry what the client is not told", () => {
  /* Support needs this on day one: somebody WILL type "summarize this" and
     needs an answer better than "that's odd". Separate from the client guide,
     because documenting a gap is not the same as teaching a workaround. */
  it("lists the actions that behave like something else", () => {
    const notes = operatorNotes();
    const divergent = MODULE_CAPABILITIES.flatMap((m) =>
      m.actions.filter((a) => a.status === "routes_elsewhere"),
    );
    expect(notes).toHaveLength(divergent.length);
    for (const n of notes) expect(n.actually.length).toBeGreaterThan(10);
  });

  it("says what actually happens, not just that it differs", () => {
    for (const n of operatorNotes()) {
      expect(n.actually).toMatch(/Behaves like/);
    }
  });
});

describe("an unverified deployment says so", () => {
  /* A deployment with nothing verified must not print an empty heading and
     imply the product does nothing. */
  it("returns a plain sentence rather than an empty document", () => {
    expect(clientGuideMarkdown([])).toMatch(/No capabilities have been verified/);
  });

  it("omits a module whose actions are all unverified", () => {
    const sections = clientGuide([
      {
        source: "documents",
        label: "Documents",
        actions: [
          {
            id: "x.y",
            verb: "v",
            example: "e",
            returns: "list",
            status: "routes_elsewhere",
            because: "because reasons here",
          },
        ],
      },
    ]);
    expect(sections).toEqual([]);
  });
});
