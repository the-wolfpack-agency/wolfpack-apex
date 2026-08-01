/**
 * The gate for prompted style changes. Most of these describe a REFUSAL,
 * because the value of this module is entirely in what it will not do: a model
 * cannot write CSS through it, cannot invent a token, cannot land on a value
 * outside the design system, and cannot move the whole scale in one turn.
 */
import { resolveIntent, parseIntent, nearestOnScale, describeDelta, ADJUSTABLE, type StyleIntent } from "../style-intent";

const intent = (over: Partial<StyleIntent> = {}): StyleIntent => ({
  sectionIndex: 0,
  token: "fontSize",
  direction: "increase",
  steps: 1,
  ...over,
});

describe("resolveIntent", () => {
  it("steps up the scale, not by an arbitrary amount", () => {
    // 21 -> 24 is the next entry. A prompted change lands ON the system.
    const r = resolveIntent(intent(), 21);
    expect(r).toEqual({ ok: true, delta: { sectionIndex: 0, token: "fontSize", from: 21, to: 24, cssValue: "24px" } });
  });

  it("steps down, and carries the unit the family declares", () => {
    const r = resolveIntent(intent({ token: "lineHeight", direction: "decrease" }), 1.5);
    expect(r.ok && r.delta).toMatchObject({ from: 1.5, to: 1.4, cssValue: "1.4" });
  });

  it("snaps a legacy off-scale value onto the system before stepping", () => {
    // A conversion from a prototype often carries a number nobody chose, like
    // 23px. Refusing to touch it would strand the operator; snapping pulls the
    // site back toward its own scale instead of drifting further off it.
    const r = resolveIntent(intent(), 23);
    expect(r.ok && r.delta.from).toBe(24);
    expect(r.ok && r.delta.to).toBe(28);
  });

  it("refuses to move more than three steps in one turn", () => {
    // "Much bigger" must not be able to jump the scale: a prompted edit has to
    // stay small enough that a person can review it.
    const r = resolveIntent(intent({ steps: 9 }), 16);
    expect(r).toMatchObject({ ok: false, refusedBecause: "off-scale" });
    expect(r.ok === false && r.reason).toMatch(/at most 3 steps/);
  });

  it("refuses to walk off either end of the scale", () => {
    const top = resolveIntent(intent(), 72);
    expect(top).toMatchObject({ ok: false, refusedBecause: "off-scale" });
    expect(top.ok === false && top.reason).toMatch(/top of the scale/);

    const bottom = resolveIntent(intent({ direction: "decrease" }), 12);
    expect(bottom.ok === false && bottom.reason).toMatch(/bottom of the scale/);
  });

  it("refuses an exact value that is not on the scale, and names the nearest one", () => {
    // The refusal that keeps the design system a system. The message is
    // actionable, so the operator is not left guessing what is allowed.
    const r = resolveIntent(intent({ direction: "set", value: 23 }), 16);
    expect(r).toMatchObject({ ok: false, refusedBecause: "off-scale" });
    expect(r.ok === false && r.reason).toMatch(/nearest is 24px/);
  });

  it("accepts an exact value that IS on the scale", () => {
    const r = resolveIntent(intent({ direction: "set", value: 40 }), 16);
    expect(r.ok && r.delta.to).toBe(40);
  });

  it("refuses a no-op rather than recording an empty change", () => {
    expect(resolveIntent(intent({ direction: "set", value: 16 }), 16)).toMatchObject({ ok: false, refusedBecause: "no-change" });
    expect(resolveIntent(intent({ steps: 0 }), 16)).toMatchObject({ ok: false, refusedBecause: "no-change" });
  });

  it("refuses when the current value could not be read", () => {
    expect(resolveIntent(intent(), Number.NaN)).toMatchObject({ ok: false, refusedBecause: "bad-input" });
  });

  it("refuses set without a value", () => {
    expect(resolveIntent(intent({ direction: "set" }), 16)).toMatchObject({ ok: false, refusedBecause: "bad-input" });
  });
});

describe("parseIntent", () => {
  it("accepts a well-formed proposal", () => {
    const r = parseIntent({ sectionIndex: 2, token: "spaceY", direction: "decrease", steps: 2 });
    expect(r).toEqual({ ok: true, intent: { sectionIndex: 2, token: "spaceY", direction: "decrease", steps: 2 } });
  });

  it("refuses a token that is not adjustable, listing what is", () => {
    // A model asking for `content` or `background` gets a refusal, not a
    // best-effort interpretation. Best-effort interpretation of untrusted text
    // is the exact shape of the injection this design avoids.
    const r = parseIntent({ sectionIndex: 0, token: "content", direction: "set", value: 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("fontSize");
  });

  it("refuses CSS, prose, and anything that is not an object", () => {
    for (const bad of ["h1 { font-size: 2rem }", "make it bigger", 42, null, undefined, []]) {
      expect(parseIntent(bad).ok).toBe(false);
    }
  });

  it("refuses a bad direction and a bad section index", () => {
    expect(parseIntent({ sectionIndex: 0, token: "fontSize", direction: "embiggen" }).ok).toBe(false);
    expect(parseIntent({ sectionIndex: -1, token: "fontSize", direction: "increase" }).ok).toBe(false);
    expect(parseIntent({ sectionIndex: 1.5, token: "fontSize", direction: "increase" }).ok).toBe(false);
  });

  it("never carries an extra field through, so nothing rides along with the intent", () => {
    const r = parseIntent({ sectionIndex: 0, token: "fontSize", direction: "increase", steps: 1, css: "color:red", onClick: "alert(1)" });
    expect(r.ok && Object.keys(r.intent).sort()).toEqual(["direction", "sectionIndex", "steps", "token"]);
  });
});

describe("nearestOnScale", () => {
  it("picks the closest entry, including at the extremes", () => {
    expect(nearestOnScale("fontSize", 23)).toBe(24);
    expect(nearestOnScale("fontSize", 1)).toBe(12);
    expect(nearestOnScale("fontSize", 900)).toBe(72);
  });
});

describe("describeDelta", () => {
  it("reads as a sentence an operator can accept or reject", () => {
    const r = resolveIntent(intent(), 21);
    expect(r.ok && describeDelta(r.delta)).toBe("fontSize up from 21px to 24px on section 0");
  });
});

describe("the adjustable surface itself", () => {
  it("every family has an ascending scale and a declared unit", () => {
    // An unsorted scale would make "increase" move down somewhere in the middle.
    for (const [name, family] of Object.entries(ADJUSTABLE)) {
      const scale = [...family.scale];
      // Named in the payload rather than as a second expect() argument: jest
      // takes exactly one, and a bare "arrays differ" would not say which family.
      expect({ name, scale }).toEqual({ name, scale: [...scale].sort((a, b) => a - b) });
      expect(typeof family.unit).toBe("string");
    }
  });

  it("covers only layout and type, never colour or content", () => {
    // Colour is brand and content is voice. Both are proposal-and-accept, not
    // things a prompted edit applies on its own.
    const names = Object.keys(ADJUSTABLE);
    expect(names.some((n) => /colou?r|background|content|text/i.test(n))).toBe(false);
  });
});
