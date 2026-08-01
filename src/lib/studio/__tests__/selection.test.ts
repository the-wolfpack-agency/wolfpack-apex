/**
 * Selection arrives from an iframe, so it is a message from another window and
 * is treated as hostile input. These tests are mostly about what gets thrown
 * away: prototype pollution, non-numbers, unknown tokens, and out-of-range
 * indices all have to die at this boundary, because everything past it assumes
 * a Selection is real.
 */
import { sanitizeMeasured, selectionFromMessage, currentValueFor, adjustableTokensFor, describeSelection, measureElement, type Selection } from "../selection";
import { resolveIntent } from "../style-intent";

const message = (over: Record<string, unknown> = {}) => ({
  origin: "instinct.preview.v1",
  type: "element.select",
  pageIndex: 0,
  sectionIndex: 2,
  sectionType: "hero",
  part: "heading",
  measured: { fontSize: 59, spaceY: 40 },
  ...over,
});

describe("sanitizeMeasured", () => {
  it("keeps known tokens with finite numbers", () => {
    expect(sanitizeMeasured({ fontSize: 24, spaceY: 16 })).toEqual({ fontSize: 24, spaceY: 16 });
  });

  it("drops unknown keys, so nothing the gate cannot act on gets stored", () => {
    expect(sanitizeMeasured({ fontSize: 24, color: 999, onClick: 1 })).toEqual({ fontSize: 24 });
  });

  it("drops NaN and Infinity, which is what an unset CSS value parses to", () => {
    // getComputedStyle returns "normal" for an unset line-height. NaN must not
    // become a value the gate steps from.
    expect(sanitizeMeasured({ fontSize: Number.NaN, lineHeight: Number.POSITIVE_INFINITY, spaceY: 8 })).toEqual({ spaceY: 8 });
  });

  it("refuses a polluted prototype rather than spreading it into state", () => {
    // `{...incoming}` from another window carries whatever it was given.
    const hostile = JSON.parse('{"fontSize": 24, "__proto__": {"polluted": true}}');
    const out = sanitizeMeasured(hostile);
    expect(out).toEqual({ fontSize: 24 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBeNull();
  });

  it("ignores an inherited value masquerading as a measurement", () => {
    const parent = { fontSize: 99 };
    const child = Object.create(parent);
    expect(sanitizeMeasured(child)).toEqual({});
  });

  it("returns an empty object for anything that is not a plain object", () => {
    for (const bad of [null, undefined, 42, "fontSize:24", [1, 2]]) {
      expect(sanitizeMeasured(bad)).toEqual({});
    }
  });
});

describe("selectionFromMessage", () => {
  it("accepts a well-formed selection", () => {
    expect(selectionFromMessage(message())).toEqual({
      pageIndex: 0,
      sectionIndex: 2,
      sectionType: "hero",
      part: "heading",
      measured: { fontSize: 59, spaceY: 40 },
    });
  });

  it("refuses a negative or fractional index", () => {
    // Well-formed at the protocol level, meaningless to the studio. The two
    // checks answer different questions and both have to run.
    expect(selectionFromMessage(message({ sectionIndex: -1 }))).toBeNull();
    expect(selectionFromMessage(message({ pageIndex: 1.5 }))).toBeNull();
  });

  it("refuses an unknown part and an empty section type", () => {
    expect(selectionFromMessage(message({ part: "everything" }))).toBeNull();
    expect(selectionFromMessage(message({ sectionType: "" }))).toBeNull();
  });

  it("refuses any other message type", () => {
    expect(selectionFromMessage(message({ type: "brief.push" }))).toBeNull();
    expect(selectionFromMessage("element.select")).toBeNull();
    expect(selectionFromMessage(null)).toBeNull();
  });

  it("survives a message with no measurements at all", () => {
    const s = selectionFromMessage(message({ measured: undefined }));
    expect(s?.measured).toEqual({});
  });
});

describe("currentValueFor", () => {
  const selection = selectionFromMessage(message()) as Selection;

  it("returns the measured value", () => {
    expect(currentValueFor(selection, "fontSize")).toBe(59);
  });

  it("returns null for a token that was not measured, rather than a default", () => {
    // A default would step from a number that is not on the operator's screen,
    // and the change would land somewhere they did not ask for. A refusal they
    // can act on beats a silent wrong answer.
    expect(currentValueFor(selection, "radius")).toBeNull();
  });
});

describe("adjustableTokensFor", () => {
  it("offers only what was actually measured", () => {
    expect(adjustableTokensFor(selectionFromMessage(message()) as Selection).sort()).toEqual(["fontSize", "spaceY"]);
  });

  it("offers nothing when nothing was measured", () => {
    expect(adjustableTokensFor(selectionFromMessage(message({ measured: {} })) as Selection)).toEqual([]);
  });
});

describe("selection feeding the style gate", () => {
  it("a measured selection produces a delta the gate accepts", () => {
    // The whole point of carrying measurements with the selection: the gate
    // has the value it is stepping from, in one round trip.
    const selection = selectionFromMessage(message()) as Selection;
    const current = currentValueFor(selection, "fontSize") as number;
    const r = resolveIntent({ sectionIndex: selection.sectionIndex, token: "fontSize", direction: "decrease", steps: 1 }, current);
    expect(r.ok && r.delta).toMatchObject({ from: 59, to: 48, sectionIndex: 2 });
  });

  it("an unmeasured token cannot be changed, because there is nothing to step from", () => {
    const selection = selectionFromMessage(message()) as Selection;
    expect(currentValueFor(selection, "letterSpacing")).toBeNull();
  });
});

describe("measureElement", () => {
  const fakeEl = (style: Record<string, string>) => ({
    getBoundingClientRect: () => ({ width: 100 }),
    ownerDocument: { defaultView: { getComputedStyle: () => style } },
  });

  it("reads what is rendered, not what was authored", () => {
    // A section can inherit its type scale from the theme or carry a number
    // over from a prototype conversion. Measuring is the only way to know.
    const out = measureElement(fakeEl({ fontSize: "24px", lineHeight: "36px", paddingTop: "16px", paddingLeft: "24px", borderTopLeftRadius: "8px", maxWidth: "1190px", letterSpacing: "0.02em" }));
    expect(out.fontSize).toBe(24);
    expect(out.lineHeight).toBeCloseTo(1.5, 5);
    expect(out).toMatchObject({ spaceY: 16, spaceX: 24, radius: 8, maxWidth: 1190 });
  });

  it("drops an unset line-height instead of inventing one", () => {
    const out = measureElement(fakeEl({ fontSize: "16px", lineHeight: "normal", paddingTop: "0px" }));
    expect(out.lineHeight).toBeUndefined();
    expect(out.fontSize).toBe(16);
  });

  it("returns nothing when there is no window to measure in", () => {
    expect(measureElement({ getBoundingClientRect: () => ({ width: 0 }), ownerDocument: null })).toEqual({});
  });
});

describe("describeSelection", () => {
  it("names what is selected for the inspector header", () => {
    expect(describeSelection(selectionFromMessage(message()) as Selection)).toBe("hero · heading (section 2)");
  });
});
