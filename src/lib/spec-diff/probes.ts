/**
 * Browser-side probes for spec-diff.
 *
 * These functions are serialized and evaluated INSIDE the page, so they must be
 * self-contained: no imports, no closure over module scope. They are kept apart
 * from compare.ts (pure, unit tested) and run.ts (orchestration) so the only
 * code that depends on a live DOM sits in one file.
 */
import type { SpecItem, FontSample } from "./compare";

/**
 * Index every visible piece of text with its geometry and type scale.
 *
 * Own text only: a wrapper that merely contains other text elements is skipped,
 * otherwise a section would be counted once per descendant and drown the report.
 */
export function collectItems(): SpecItem[] {
  const norm = (s: string | null): string => (s || "").replace(/\s+/g, " ").trim();
  const px = (v: number): number => Math.round(v * 10) / 10;
  const TAGS = new Set(["H1", "H2", "H3", "H4", "P", "BUTTON", "A", "LABEL", "SUMMARY", "LI", "TD", "TH", "STRONG", "SPAN", "DIV"]);
  const seen = new Map<string, SpecItem>();

  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (!TAGS.has(el.tagName)) continue;
    const ownText = norm(
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(" "),
    );
    if (ownText.length < 3 || ownText.length > 90) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;

    const key = `${el.tagName}::${ownText.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      tag: el.tagName,
      text: ownText.slice(0, 60),
      top: px(b.top + window.scrollY),
      left: px(b.left),
      width: px(b.width),
      height: px(b.height),
      fontSize: parseFloat(s.fontSize),
      lineHeight: s.lineHeight === "normal" ? null : parseFloat(s.lineHeight),
      fontWeight: s.fontWeight,
      fontFamily: s.fontFamily.split(",")[0].replace(/["']/g, ""),
      textAlign: s.textAlign,
    });
  }
  return Array.from(seen.values());
}

/**
 * Measure the font that is actually rendering, plus the files the page serves.
 *
 * Declared family names lie: two builds can both say the same family while
 * shipping different cuts, which silently rewraps every paragraph. Glyph advance
 * does not lie.
 */
export function collectFont(): FontSample {
  const body = getComputedStyle(document.body);
  const family = body.fontFamily.split(",")[0].replace(/["']/g, "");
  const ctx = document.createElement("canvas").getContext("2d");
  const SAMPLE = "Weekend with Porsche 0123456789";
  let sampleWidth = 0;
  if (ctx) {
    ctx.font = `100px "${family}"`;
    sampleWidth = Math.round(ctx.measureText(SAMPLE).width * 100) / 100;
  }

  const sources: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRule[] = [];
    try {
      rules = Array.from(sheet.cssRules || []);
    } catch {
      continue; // cross-origin stylesheet, not readable
    }
    for (const rule of rules) {
      const style = (rule as CSSFontFaceRule).style;
      if (!style || rule.constructor?.name !== "CSSFontFaceRule") continue;
      const src = style.getPropertyValue("src") || "";
      const file = (src.match(/[^/"']+\.(?:woff2?|otf|ttf)/i) || [])[0];
      const weight = style.getPropertyValue("font-weight") || "";
      if (file) sources.push(weight ? `${file} (${weight})` : file);
    }
  }
  return { family, sampleWidth, sources: Array.from(new Set(sources)).slice(0, 8) };
}

/**
 * Every design token declared in the page's stylesheets, with the selector that
 * declares it. Not only :root: an app may scope its tokens to a class, and a
 * :root-only scan then reports "we carry none of the prototype's values", which
 * is wrong and sends the operator chasing a phantom.
 */
export function collectTokens(): { flat: Record<string, string>; bySelector: Record<string, Record<string, string>> } {
  const flat: Record<string, string> = {};
  const bySelector: Record<string, Record<string, string>> = {};

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRule[] = [];
    try {
      rules = Array.from(sheet.cssRules || []);
    } catch {
      continue;
    }
    const walk = (list: CSSRule[]): void => {
      for (const rule of list) {
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested) walk(Array.from(nested));
        const styleRule = rule as CSSStyleRule;
        if (!styleRule.selectorText || !styleRule.style) continue;
        for (const prop of Array.from(styleRule.style)) {
          if (!prop.startsWith("--")) continue;
          const value = styleRule.style.getPropertyValue(prop).trim();
          flat[prop] = value;
          (bySelector[styleRule.selectorText] ||= {})[prop] = value;
        }
      }
    };
    walk(rules);
  }
  return { flat, bySelector };
}
