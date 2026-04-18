/**
 * site-theme pure helpers — unit tests.
 *
 * Covers:
 *   - themeToCssVars({}) / undefined → {}
 *   - full theme returns all 5 color vars + font var
 *   - partial theme returns only set vars
 *   - invalid hex values are dropped (omitted, not silently written)
 *   - hexToRgb parses valid hex + rejects invalid
 *   - normalizeTheme handles nested + legacy flat shapes
 *   - CURATED_FONTS is non-empty, unique ids, valid categories
 *
 * Note: this file tests pure TS; no jsdom needed.
 */

import {
  CURATED_FONTS,
  DEFAULT_THEME,
  THEME_COLOR_KEYS,
  hexToRgb,
  isValidHex,
  normalizeTheme,
  themeToCssVars,
} from "@/lib/site-theme";

describe("themeToCssVars", () => {
  it("returns {} for undefined theme", () => {
    expect(themeToCssVars(undefined)).toEqual({});
  });

  it("returns {} for null / non-object", () => {
    // TS would reject these at compile time; still guard at runtime.
    expect(themeToCssVars(null as unknown as undefined)).toEqual({});
    expect(themeToCssVars("nope" as unknown as undefined)).toEqual({});
  });

  it("returns {} for empty theme", () => {
    expect(themeToCssVars({})).toEqual({});
    expect(themeToCssVars({ colors: {} })).toEqual({});
  });

  it("returns all 5 color vars + font var for a fully populated theme", () => {
    const vars = themeToCssVars({
      colors: {
        primary: "#112233",
        accent: "#aabbcc",
        bg: "#000000",
        fg: "#ffffff",
        muted: "#808080",
      },
      font: {
        family: "'Inter', sans-serif",
        googleFontName: "Inter",
      },
    });
    expect(vars).toEqual({
      "--wp-site-primary": "#112233",
      "--wp-site-accent": "#aabbcc",
      "--wp-site-bg": "#000000",
      "--wp-site-fg": "#ffffff",
      "--wp-site-muted": "#808080",
      "--wp-site-font-family": "'Inter', sans-serif",
    });
  });

  it("returns only the set color vars on a partial theme", () => {
    const vars = themeToCssVars({ colors: { primary: "#abcdef" } });
    expect(vars).toEqual({ "--wp-site-primary": "#abcdef" });
  });

  it("omits invalid hex values (does not emit empty-string or raw text)", () => {
    const vars = themeToCssVars({
      colors: {
        primary: "not-a-hex",
        accent: "#fff",        // short-hex: rejected
        bg: "#112233",
      },
    });
    expect(vars).toEqual({ "--wp-site-bg": "#112233" });
  });

  it("omits font family when empty or whitespace-only", () => {
    expect(themeToCssVars({ font: { family: "" } })).toEqual({});
    expect(themeToCssVars({ font: { family: "   " } })).toEqual({});
  });

  it("accepts uppercase hex codes", () => {
    const vars = themeToCssVars({ colors: { primary: "#ABCDEF" } });
    expect(vars["--wp-site-primary"]).toBe("#ABCDEF");
  });

  it("emits every key in THEME_COLOR_KEYS when provided", () => {
    const allColors: Record<string, string> = {};
    for (const key of THEME_COLOR_KEYS) {
      allColors[key] = "#101010";
    }
    const vars = themeToCssVars({ colors: allColors });
    for (const key of THEME_COLOR_KEYS) {
      expect(vars[`--wp-site-${key}`]).toBe("#101010");
    }
  });
});

describe("hexToRgb", () => {
  it("parses a valid lowercase hex", () => {
    expect(hexToRgb("#112233")).toEqual({ r: 17, g: 34, b: 51 });
  });

  it("parses a valid uppercase hex", () => {
    expect(hexToRgb("#AABBCC")).toEqual({ r: 170, g: 187, b: 204 });
  });

  it("returns null for short hex", () => {
    expect(hexToRgb("#fff")).toBeNull();
  });

  it("returns null for hex with alpha", () => {
    expect(hexToRgb("#11223344")).toBeNull();
  });

  it("returns null for missing hash", () => {
    expect(hexToRgb("112233")).toBeNull();
  });

  it("returns null for non-hex characters", () => {
    expect(hexToRgb("#zzzzzz")).toBeNull();
  });

  it("returns null for undefined / null / non-strings", () => {
    expect(hexToRgb(undefined)).toBeNull();
    expect(hexToRgb(null)).toBeNull();
    expect(hexToRgb("" as string)).toBeNull();
    expect(hexToRgb(42 as unknown as string)).toBeNull();
  });
});

describe("isValidHex", () => {
  it("accepts valid #rrggbb", () => {
    expect(isValidHex("#abcdef")).toBe(true);
    expect(isValidHex("#000000")).toBe(true);
    expect(isValidHex("#FFFFFF")).toBe(true);
  });

  it("rejects short hex, alpha, non-hex, undefined", () => {
    expect(isValidHex("#fff")).toBe(false);
    expect(isValidHex("#ff000080")).toBe(false);
    expect(isValidHex("abcdef")).toBe(false);
    expect(isValidHex(undefined)).toBe(false);
  });
});

describe("normalizeTheme", () => {
  it("returns undefined for null / non-object", () => {
    expect(normalizeTheme(null)).toBeUndefined();
    expect(normalizeTheme(undefined)).toBeUndefined();
    expect(normalizeTheme("x")).toBeUndefined();
  });

  it("passes through a nested-shape theme unchanged", () => {
    const theme = { colors: { primary: "#112233" }, font: { family: "'Inter', sans-serif" } };
    expect(normalizeTheme(theme)).toEqual(theme);
  });

  it("lifts the legacy flat form into the nested shape", () => {
    const legacy = { primary: "#112233", accent: "#aabbcc", font: "Inter" };
    const normalized = normalizeTheme(legacy);
    expect(normalized?.colors?.primary).toBe("#112233");
    expect(normalized?.colors?.accent).toBe("#aabbcc");
    expect(normalized?.font?.family).toBe("Inter");
  });

  it("drops unknown keys when lifting the flat form", () => {
    const legacy = { primary: "#112233", random: "unused" };
    const normalized = normalizeTheme(legacy);
    // Don't assert absence by JSON shape — just that unknown keys
    // don't show up on `colors` or `font`.
    expect(Object.keys(normalized?.colors ?? {})).toEqual(["primary"]);
  });

  it("drops invalid hex values in the flat form", () => {
    const legacy = { primary: "not-a-hex" };
    const normalized = normalizeTheme(legacy);
    expect(normalized?.colors?.primary).toBeUndefined();
  });
});

describe("CURATED_FONTS + DEFAULT_THEME", () => {
  it("has at least 10 entries", () => {
    expect(CURATED_FONTS.length).toBeGreaterThanOrEqual(10);
  });

  it("every entry has id, name, family, category", () => {
    for (const font of CURATED_FONTS) {
      expect(typeof font.id).toBe("string");
      expect(font.id.length).toBeGreaterThan(0);
      expect(typeof font.name).toBe("string");
      expect(font.family.length).toBeGreaterThan(0);
      expect(["sans", "serif", "mono", "display"]).toContain(font.category);
    }
  });

  it("ids are unique", () => {
    const ids = CURATED_FONTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all four categories", () => {
    const cats = new Set(CURATED_FONTS.map((f) => f.category));
    expect(cats).toEqual(new Set(["sans", "serif", "mono", "display"]));
  });

  it("every family string ends with a generic fallback", () => {
    // Each family string must include a generic family name so browsers
    // don't fall back to Times New Roman when the <link> tag fails.
    const generics = ["sans-serif", "serif", "monospace", "system-ui", "ui-monospace"];
    for (const font of CURATED_FONTS) {
      const hasGeneric = generics.some((g) => font.family.includes(g));
      expect({ id: font.id, hasGeneric }).toEqual({ id: font.id, hasGeneric: true });
    }
  });

  it("DEFAULT_THEME contains every color key + a font family", () => {
    for (const key of THEME_COLOR_KEYS) {
      const v = DEFAULT_THEME.colors?.[key];
      expect(isValidHex(v)).toBe(true);
    }
    expect(DEFAULT_THEME.font?.family).toBeTruthy();
    expect(DEFAULT_THEME.font?.googleFontName).toBeTruthy();
  });

  it("themeToCssVars(DEFAULT_THEME) emits all 5 colors + font var", () => {
    const vars = themeToCssVars(DEFAULT_THEME);
    expect(Object.keys(vars).sort()).toEqual(
      [
        "--wp-site-accent",
        "--wp-site-bg",
        "--wp-site-fg",
        "--wp-site-font-family",
        "--wp-site-muted",
        "--wp-site-primary",
      ].sort(),
    );
  });
});
