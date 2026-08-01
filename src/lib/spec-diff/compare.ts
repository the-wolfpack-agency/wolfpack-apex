/**
 * Spec-diff comparison logic: does an implementation match the prototype it was
 * built from, numerically?
 *
 * Converting a wireframe by eye is how a 6px header, a 63px hero and a 19px
 * heading all ship as "matching the spec", and it costs a review cycle per bug
 * because the only detector is a human noticing. Layout is arithmetic, so this
 * compares measurements instead.
 *
 * A prototype shares no class names or ids with the build that follows it, but
 * it does share COPY, so the copy is the join key: tag + the element's own text.
 *
 * Pure by design. The browser work lives in probes.ts and run.ts, so every rule
 * here is unit tested without a browser, a network or a database.
 */

/** One measured piece of text on a page. */
export interface SpecItem {
  tag: string;
  text: string;
  top: number;
  left: number;
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number | null;
  fontWeight: string;
  fontFamily: string;
  textAlign: string;
}

/** What the page's actual rendering font measures, regardless of its name. */
export interface FontSample {
  family: string;
  sampleWidth: number;
  sources: string[];
}

export interface FieldDiff {
  field: string;
  spec: string | number;
  ours: string | number;
  delta: number | null;
}

export interface ItemDiff {
  tag: string;
  text: string;
  fields: FieldDiff[];
}

export interface FontDiff {
  mismatch: boolean;
  percent: number;
  spec: FontSample;
  ours: FontSample;
}

export interface CompareResult {
  diffs: ItemDiff[];
  missing: { tag: string; text: string }[];
  matched: number;
}

/** Numeric fields, compared with a pixel tolerance. */
export const GEOMETRY_FIELDS = ["top", "left", "width", "height"] as const;
export const TYPE_FIELDS = ["fontSize", "lineHeight"] as const;
/** Fields that must match exactly; a tolerance would be meaningless. */
export const EXACT_FIELDS = ["fontWeight", "fontFamily", "textAlign"] as const;

export const DEFAULT_TOLERANCE_PX = 1.5;
/** Glyph advance beyond this much difference means a different cut of the font. */
export const FONT_WIDTH_TOLERANCE_PCT = 0.5;

/** The join key: tag plus the element's own text, case-insensitive. */
export function keyOf(item: Pick<SpecItem, "tag" | "text">): string {
  return `${item.tag}::${String(item.text ?? "").toLowerCase()}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compare an implementation's measurements against the prototype's. Only fields
 * that actually disagree are returned, so the report is a work list rather than
 * a dump of both pages.
 */
export function compareItems(specItems: SpecItem[], oursItems: SpecItem[], tolerance = DEFAULT_TOLERANCE_PX): CompareResult {
  const oursByKey = new Map(oursItems.map((i) => [keyOf(i), i]));
  const diffs: ItemDiff[] = [];
  const missing: { tag: string; text: string }[] = [];
  let matched = 0;

  for (const s of specItems) {
    const o = oursByKey.get(keyOf(s));
    if (!o) {
      missing.push({ tag: s.tag, text: s.text });
      continue;
    }
    matched += 1;
    const fields: FieldDiff[] = [];

    for (const f of [...GEOMETRY_FIELDS, ...TYPE_FIELDS]) {
      const sv = s[f];
      const ov = o[f];
      if (sv == null || ov == null) continue;
      const delta = round1(ov - sv);
      if (Math.abs(delta) > tolerance) fields.push({ field: f, spec: sv, ours: ov, delta });
    }
    for (const f of EXACT_FIELDS) {
      if (s[f] == null || o[f] == null) continue;
      if (s[f] !== o[f]) fields.push({ field: f, spec: s[f], ours: o[f], delta: null });
    }

    if (fields.length) diffs.push({ tag: s.tag, text: s.text, fields });
  }

  // Largest drift first: on a vertical layout the topmost, biggest offset is
  // usually the cause of every offset beneath it.
  diffs.sort((a, b) => worstDelta(b) - worstDelta(a));
  return { diffs, missing, matched };
}

function worstDelta(diff: ItemDiff): number {
  return Math.max(0, ...diff.fields.map((f) => (f.delta == null ? 0 : Math.abs(f.delta))));
}

/**
 * Compare the font that is ACTUALLY rendering on each side.
 *
 * Two builds can both declare the same family while serving different cuts of
 * it. That changes every line wrap on the page and is invisible to a name
 * comparison, so this measures glyph advance instead. Observed in the field: a
 * 5.04% wider cut of the same licensed family.
 */
export function compareFonts(spec: FontSample | null, ours: FontSample | null, tolerancePct = FONT_WIDTH_TOLERANCE_PCT): FontDiff | null {
  if (!spec || !ours) return null;
  const percent = spec.sampleWidth ? ((ours.sampleWidth - spec.sampleWidth) / spec.sampleWidth) * 100 : 0;
  return {
    mismatch: Math.abs(percent) > tolerancePct,
    percent: Math.round(percent * 100) / 100,
    spec,
    ours,
  };
}

export interface ViewportResult extends CompareResult {
  viewport: { width: number; height: number };
  font: FontDiff | null;
}

/** Roll every viewport into the numbers an operator and the gate both need. */
export function summarize(results: ViewportResult[]): {
  totalDiffs: number;
  totalMissing: number;
  fontMismatch: boolean;
  matchedElements: number;
  clean: boolean;
  worstOffenders: { text: string; field: string; delta: number }[];
} {
  const totalDiffs = results.reduce((n, r) => n + r.diffs.length, 0);
  const totalMissing = results.reduce((n, r) => n + r.missing.length, 0);
  const fontMismatch = results.some((r) => r.font?.mismatch === true);
  const matchedElements = results.reduce((n, r) => n + r.matched, 0);

  const worstOffenders = results
    .flatMap((r) => r.diffs.flatMap((d) => d.fields.filter((f) => f.delta != null).map((f) => ({ text: d.text, field: f.field, delta: Math.abs(f.delta as number) }))))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5);

  return { totalDiffs, totalMissing, fontMismatch, matchedElements, clean: totalDiffs === 0 && !fontMismatch, worstOffenders };
}
