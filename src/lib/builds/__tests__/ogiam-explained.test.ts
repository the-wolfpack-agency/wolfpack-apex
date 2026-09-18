/**
 * The OGIAM explainer must not blur what is built with what is coming. The
 * checkable structure is pinned here: the shipped capabilities are present and
 * NOT flagged roadmap, exactly one section (Forcefield for the Web) IS flagged
 * roadmap, and every section carries plain-language body + a "what this means"
 * line where the page expects one.
 */
import { OGIAM_HEADLINE, OGIAM_ANALOGY, OGIAM_SECTIONS, OGIAM_CLOSER } from "@/lib/builds/ogiam-explained";

describe("OGIAM explainer content", () => {
  it("covers the shipped capabilities plus the roadmap section, in order", () => {
    expect(OGIAM_SECTIONS.map((s) => s.id)).toEqual([
      "secure-agent",
      "forcefield",
      "any-model",
      "why-different",
      "self-serve",
      "proof",
      "forcefield-web",
    ]);
  });

  it("flags EXACTLY the coming-next capability as roadmap, and nothing built", () => {
    const roadmap = OGIAM_SECTIONS.filter((s) => s.roadmap).map((s) => s.id);
    expect(roadmap).toEqual(["forcefield-web"]);
    // Everything else is a built capability, not marked coming-next.
    for (const s of OGIAM_SECTIONS) {
      if (s.id !== "forcefield-web") expect(s.roadmap).toBeFalsy();
    }
  });

  it("gives every section a title, an eyebrow, and real body copy", () => {
    for (const s of OGIAM_SECTIONS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.eyebrow.trim().length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.body.every((p) => p.trim().length > 0)).toBe(true);
    }
  });

  it("gives each capability a plain 'what this means for you' line", () => {
    for (const s of OGIAM_SECTIONS) {
      expect(s.meaning && s.meaning.trim().length).toBeGreaterThan(0);
    }
  });

  it("only Secure Agent walks through numbered steps", () => {
    const withSteps = OGIAM_SECTIONS.filter((s) => s.how && s.how.length > 0).map((s) => s.id);
    expect(withSteps).toEqual(["secure-agent"]);
  });

  it("has a headline, analogy, and closer for the non-technical reader", () => {
    expect(OGIAM_HEADLINE.length).toBeGreaterThan(40);
    expect(OGIAM_ANALOGY.toLowerCase()).toContain("employee");
    expect(OGIAM_CLOSER.length).toBeGreaterThan(40);
  });
});
