/**
 * Unit tests for the spec-diff comparison rules. Each case maps to a real defect
 * that shipped because a conversion was checked by eye instead of measured.
 */
import { compareItems, compareFonts, summarize, keyOf, type SpecItem, type ViewportResult } from "../compare";

const item = (over: Partial<SpecItem> = {}): SpecItem => ({
  tag: "H1",
  text: "A Weekend with Porsche",
  top: 100,
  left: 50,
  width: 400,
  height: 80,
  fontSize: 76,
  lineHeight: 83.6,
  fontWeight: "400",
  fontFamily: "Porsche Next",
  textAlign: "start",
  ...over,
});

describe("keyOf", () => {
  it("joins documents on copy, case-insensitively", () => {
    expect(keyOf({ tag: "H2", text: "Program Overview" })).toBe(keyOf({ tag: "H2", text: "PROGRAM overview" }));
  });

  it("keeps different tags distinct even with identical copy", () => {
    expect(keyOf({ tag: "H2", text: "Program Overview" })).not.toBe(keyOf({ tag: "H3", text: "Program Overview" }));
  });
});

describe("compareItems", () => {
  it("reports nothing when the implementation matches", () => {
    const { diffs, missing, matched } = compareItems([item()], [item()]);
    expect(diffs).toHaveLength(0);
    expect(missing).toHaveLength(0);
    expect(matched).toBe(1);
  });

  it("returns only the fields that disagree, with a signed delta", () => {
    const { diffs } = compareItems([item({ top: 100, fontSize: 40 })], [item({ top: 130, fontSize: 59 })]);
    expect(diffs).toHaveLength(1);
    const fields = Object.fromEntries(diffs[0].fields.map((f) => [f.field, f]));
    expect(Object.keys(fields).sort()).toEqual(["fontSize", "top"]);
    expect(fields.top).toMatchObject({ spec: 100, ours: 130, delta: 30 });
    expect(fields.fontSize.delta).toBe(19);
  });

  it("honours the pixel tolerance so sub-pixel rounding is not reported as drift", () => {
    expect(compareItems([item({ top: 100 })], [item({ top: 101 })], 1.5).diffs).toHaveLength(0);
    expect(compareItems([item({ top: 100 })], [item({ top: 101 })], 0.5).diffs).toHaveLength(1);
  });

  it("never applies a tolerance to exact fields", () => {
    const { diffs } = compareItems([item({ fontWeight: "400" })], [item({ fontWeight: "600" })]);
    expect(diffs[0].fields[0]).toMatchObject({ field: "fontWeight", spec: "400", ours: "600", delta: null });
  });

  it("lists prototype elements that are absent from the implementation", () => {
    const { missing, matched } = compareItems([item(), item({ tag: "A", text: "Sign out" })], [item()]);
    expect(matched).toBe(1);
    expect(missing).toEqual([{ tag: "A", text: "Sign out" }]);
  });

  it("ranks the largest drift first, since it usually explains the rest", () => {
    const spec = [item({ text: "small" }), item({ text: "big" })];
    const ours = [item({ text: "small", top: 103 }), item({ text: "big", top: 230 })];
    expect(compareItems(spec, ours).diffs[0].text).toBe("big");
  });

  it("skips a field that is missing on either side rather than inventing a diff", () => {
    expect(compareItems([item({ lineHeight: null })], [item({ lineHeight: 90 })]).diffs).toHaveLength(0);
  });
});

describe("compareFonts", () => {
  it("detects a different cut of the same family from glyph advance", () => {
    const font = compareFonts(
      { family: "Porsche Next", sampleWidth: 1487.1, sources: ["PorscheNext-Regular.woff2"] },
      { family: "Porsche Next", sampleWidth: 1562.08, sources: ["porsche-next-w-la-regular.woff2"] },
    );
    expect(font?.mismatch).toBe(true);
    expect(font?.percent).toBe(5.04);
  });

  it("passes identical metrics, even across different file names", () => {
    const spec = { family: "X", sampleWidth: 1000, sources: ["a.woff2"] };
    expect(compareFonts(spec, { ...spec, sources: ["b.woff2"] })?.mismatch).toBe(false);
  });

  it("returns null when either side could not be sampled", () => {
    expect(compareFonts(null, { family: "X", sampleWidth: 1, sources: [] })).toBeNull();
  });
});

describe("summarize", () => {
  const viewport = { width: 1512, height: 950 };
  const clean: ViewportResult = { viewport, diffs: [], missing: [], matched: 40, font: null };

  it("reports clean when nothing differs", () => {
    expect(summarize([clean]).clean).toBe(true);
  });

  it("is not clean when only the font differs", () => {
    const withFont: ViewportResult = {
      ...clean,
      font: { mismatch: true, percent: 5.04, spec: { family: "a", sampleWidth: 1, sources: [] }, ours: { family: "a", sampleWidth: 2, sources: [] } },
    };
    const s = summarize([withFont]);
    expect(s.clean).toBe(false);
    expect(s.fontMismatch).toBe(true);
  });

  it("totals across viewports and surfaces the worst offenders", () => {
    const a: ViewportResult = { ...clean, diffs: [{ tag: "H2", text: "Program Overview", fields: [{ field: "fontSize", spec: 40, ours: 59, delta: 19 }] }] };
    const b: ViewportResult = { ...clean, diffs: [{ tag: "DIV", text: "hero", fields: [{ field: "height", spec: 640, ours: 723, delta: 83 }] }] };
    const s = summarize([a, b]);
    expect(s.totalDiffs).toBe(2);
    expect(s.matchedElements).toBe(80);
    expect(s.worstOffenders[0]).toMatchObject({ text: "hero", field: "height", delta: 83 });
  });
});
