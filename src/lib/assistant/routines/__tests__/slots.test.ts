/**
 * Slot substitution.
 *
 * The whole data-flow mechanism between steps, so its failure modes are the
 * chain's failure modes. The one that matters most is a MISSING slot: the
 * tempting behavior is to substitute nothing and carry on, and that is how a
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

describe("a slot from a real client's data, not a test workspace's", () => {
  /* Invisible on a workspace with an empty mailbox and no deals. On a real
     CRM the same chain builds a prompt out of thousands of records, and a
     provider that truncates an over-long prompt does it silently: the model
     then reasons over a partial list and answers with complete confidence. */

  it("keeps a list short and says how much it kept", () => {
    const deals = Array.from({ length: 500 }, (_, i) => ({ id: `deal-${i}`, name: `Account ${i}` }));
    const out = interpolate("deals: {{deals}}", { deals });

    expect(out).toContain("showing the first 25 of 500");
    /* And it is still valid enough to read: the kept part is whole records. */
    expect(out).toContain("deal-0");
    expect(out).not.toContain("deal-400");
  });

  it("does not annotate a list that fits", () => {
    /* A note on every list would train everybody to ignore the note. */
    const out = interpolate("deals: {{deals}}", { deals: [{ id: "a" }, { id: "b" }] });
    expect(out).not.toMatch(/showing the first/);
  });

  it("cuts an enormous string and says it is partial", () => {
    const out = interpolate("body: {{mail}}", { mail: "x".repeat(20_000) });
    expect(out).toMatch(/treat it as partial/);
    expect(out.length).toBeLessThan(5_000);
  });

  it("says partial rather than just being shorter", () => {
    /* The marker is the whole point. Silently shorter is the dangerous
       version: the model cannot tell, so it describes a fragment as the whole.
     *
       Embedded in text, which is what a prompt looks like. A reference that IS
       the whole string is a different case on purpose, covered below: it keeps
       the value's type because a tool parameter needs the real thing. */
    const out = interpolate("here it is: {{big}}", { big: { note: "y".repeat(20_000) } });
    expect(out).toMatch(/treat it as partial/i);
  });

  it("leaves ordinary values exactly as they were", () => {
    /* The bound must not become a tax on the common case. */
    expect(interpolate("{{n}}", { n: 42 })).toBe(42);
    expect(interpolate("hi {{who}}", { who: "Dana" })).toBe("hi Dana");
    expect(interpolate("{{o}}", { o: { a: 1 } })).toEqual({ a: 1 });
  });

  it("still keeps the TYPE when a whole-string reference points at a big list", () => {
    /* Bounding is for text going into a prompt. A tool parameter that wants
       the array must still receive the array, or a chain breaks at validation
       one step later. */
    const deals = Array.from({ length: 500 }, (_, i) => i);
    expect(interpolate({ ids: "{{deals}}" }, { deals })).toEqual({ ids: deals });
  });
});
