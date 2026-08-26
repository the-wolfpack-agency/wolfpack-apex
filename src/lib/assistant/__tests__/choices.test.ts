/**
 * Offer choices instead of an apology.
 *
 * The fallback was a sentence costing about eleven hundred tokens that told
 * somebody to try again with better words, which is the thing they had just
 * failed at, plus a fixed list of chips identical whatever they typed. Somebody
 * asking whether the build was broken got offered the weather.
 *
 * A chip costs nothing and cannot be misrouted. These tests hold the two
 * properties that make it worth clicking: it is relevant to the question, and
 * it will actually work when clicked.
 */
import "@/lib/assistant/tools";
import { buildChoices, scoreChoice, CHOICES } from "@/lib/assistant/choices";
import { getTools } from "@/lib/assistant/tools/registry";

describe("chips answer the question that was asked", () => {
  it.each([
    ["what is our revenue", "A financial figure"],
    ["is the build broken", "CI status"],
    ["who works on the pilot", "Look up a person"],
    ["this page is wrong", "Report a problem"],
    ["upload the client contract", "Add a document"],
  ])("%s leads with %s", (question, expected) => {
    expect(buildChoices(question, "cto")[0].label).toBe(expected);
  });

  /* Order must not drift between identical asks. A menu that moves is a menu
     people stop trusting, and the ranking is deliberately crude precisely so
     it is deterministic. */
  it("returns the same chips in the same order for the same question", () => {
    const a = buildChoices("what is our revenue", "cto");
    const b = buildChoices("what is our revenue", "cto");
    expect(a).toEqual(b);
  });

  it("still offers something when nothing scores", () => {
    expect(buildChoices("WolfpackxPCNA", "cto").length).toBeGreaterThan(0);
  });
});

describe("a chip is never a control the person cannot use", () => {
  /* THE ROLE-MISMATCH DEFECT IN A FRIENDLIER COAT. A chip that returns "you
     lack the privilege" spends a click to teach somebody the product is
     broken, and the API refusing is correct, so the fix is never to offer it. */
  it("hides financial and CI chips from a dealer", () => {
    const labels = buildChoices("what is our revenue and is the build broken", "dealer").map(
      (c) => c.label,
    );
    expect(labels).not.toContain("A financial figure");
    expect(labels).not.toContain("CI status");
  });

  it("offers those same chips to a cto", () => {
    const labels = buildChoices("what is our revenue and is the build broken", "cto").map(
      (c) => c.label,
    );
    expect(labels).toContain("A financial figure");
    expect(labels).toContain("CI status");
  });
});

describe("every chip names a tool that exists", () => {
  /* A chip pointing at an unregistered tool cannot work, and it would be
     invisible: buildChoices drops it silently so nobody is offered a dead
     button, which means only this test would ever notice. */
  it("has no chip for a tool that is not registered", () => {
    const registered = new Set((getTools() as unknown as Array<{ name: string }>).map((t) => t.name));
    const orphans = CHOICES.filter((c) => !registered.has(c.tool)).map((c) => c.tool);
    expect(orphans).toEqual([]);
  });

  /* The scorer decides an order, not an answer, so this only has to be sane. */
  it("scores a matching word above a non-matching one", () => {
    const financial = CHOICES.find((c) => c.tool === "get_financials_metric")!;
    expect(scoreChoice("what is our revenue", financial)).toBeGreaterThan(
      scoreChoice("what is the weather", financial),
    );
  });
});
