/**
 * Slot substitution.
 *
 * The whole data-flow mechanism between steps, so its failure modes are the
 * chain's failure modes. The one that matters most is a MISSING slot: the
 * tempting behaviour is to substitute nothing and carry on, and that is how a
 * routine reaches "draft the reply" holding an empty string where the customer
 * history should be, then sends something confident and wrong.
 */
import { interpolate, referencedSlots, MissingSlotError } from "../slots";

describe("referencedSlots", () => {
  it("finds references anywhere in a parameter object", () => {
    expect(
      referencedSlots({ to: "{{person}}", body: "about {{topic}}", n: 3 }),
    ).toEqual(["person", "topic"]);
  });

  it("reports each slot once, in the order it first appears", () => {
    expect(referencedSlots("{{b}} then {{a}} then {{b}}")).toEqual(["b", "a"]);
  });

  it("looks inside arrays and nested objects", () => {
    expect(referencedSlots({ list: [{ x: "{{deep}}" }] })).toEqual(["deep"]);
  });

  /* A /g regex carries lastIndex between calls, so a shared one matches, then
     misses the identical string on the next call. In a routine that is a step
     that works on Monday and silently stops substituting on Tuesday. */
  it("gives the same answer on repeated calls", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(referencedSlots("{{inbox}}")).toEqual(["inbox"]);
    }
  });

  it("finds nothing in a template with no references", () => {
    expect(referencedSlots({ state: "open" })).toEqual([]);
  });
});

describe("interpolate", () => {
  it("substitutes into a sentence", () => {
    expect(interpolate("reply to {{who}}", { who: "Dana" })).toBe("reply to Dana");
  });

  it("KEEPS THE TYPE when the whole string is one reference", () => {
    /* A tool whose schema wants an array must receive the array. Stringifying
       it here fails zod one step later with a message about the wrong thing,
       and the person debugging reads it as a tool bug. */
    const ids = ["a", "b"];
    expect(interpolate({ ids: "{{list}}" }, { list: ids })).toEqual({ ids });
    expect(interpolate({ n: "{{count}}" }, { count: 7 })).toEqual({ n: 7 });
  });

  it("renders a structured slot as JSON inside a sentence", () => {
    /* "[object Object]" in the body of an email is the failure this prevents. */
    const out = interpolate("context: {{ctx}}", { ctx: { open: 2 } });
    expect(out).toBe('context: {"open":2}');
  });

  it("reads one field of a structured slot", () => {
    expect(interpolate("{{thread.subject}}", { thread: { subject: "Invoice" } })).toBe("Invoice");
  });

  it("substitutes through arrays and nested objects", () => {
    expect(
      interpolate({ a: [{ b: "hi {{name}}" }] }, { name: "Sam" }),
    ).toEqual({ a: [{ b: "hi Sam" }] });
  });

  it("leaves a template with no references untouched", () => {
    const params = { state: "open", limit: 20 };
    expect(interpolate(params, {})).toEqual(params);
  });

  it("THROWS on a slot no earlier step wrote", () => {
    expect(() => interpolate("hi {{nobody}}", {})).toThrow(MissingSlotError);
  });

  it("explains a missing slot in terms of the consequence", () => {
    /* The person reading this is deciding whether to edit the routine. */
    try {
      interpolate("{{history}}", {});
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as MissingSlotError).slot).toBe("history");
      expect((err as Error).message).toMatch(/no earlier step wrote/i);
    }
  });

  it("treats a slot written as null as written", () => {
    /* A step that legitimately produced nothing is not the same as a step that
       never ran, and conflating them would fail a valid chain. */
    expect(() => interpolate("x {{empty}}", { empty: null })).not.toThrow();
    expect(interpolate("x {{empty}}", { empty: null })).toBe("x ");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(interpolate("{{ who }}", { who: "Dana" })).toBe("Dana");
  });

  it("does not treat a lone brace pair as a reference", () => {
    expect(interpolate("use {braces} freely", {})).toBe("use {braces} freely");
  });
});
