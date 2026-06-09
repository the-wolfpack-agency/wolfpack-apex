import { surveyThemeVars, themeFontFace, isPorscheTheme } from "../theme";

describe("survey responder theme", () => {
  test("porsche sets the Guards Red accent, white canvas, and Porsche Next", () => {
    const v = surveyThemeVars("porsche") as Record<string, string>;
    expect(v["--wp-gold"]).toBe("#d5001c"); // Guards Red accent
    expect(v["--wp-dark-surface"]).toBe("#ffffff"); // white card
    expect(v["--wp-text"]).toBe("#010205"); // near-black ink
    expect(v["--wp-accent-fg"]).toBe("#ffffff"); // white text on red buttons
    expect(String(v.fontFamily)).toMatch(/Porsche Next/);
  });

  test("default theme applies no overrides (component fallbacks)", () => {
    expect(surveyThemeVars(null)).toEqual({});
    expect(surveyThemeVars("default")).toEqual({});
    expect(surveyThemeVars(undefined)).toEqual({});
  });

  test("porsche-sage is the pitch-deck look: sage accent on a dark canvas", () => {
    const v = surveyThemeVars("porsche-sage") as Record<string, string>;
    expect(v["--wp-gold"]).toBe("#b9d0c6"); // light, readable sage accent
    expect(v["--wp-dark"]).toBe("#101716"); // near-black canvas
    expect(v["--wp-text"]).toBe("#f4f6f5"); // light text
    expect(String(v.fontFamily)).toMatch(/Porsche Next/);
  });

  test("font-face + wordmark apply to all porsche themes, not default", () => {
    expect(themeFontFace("porsche")).toMatch(/porsche-next/);
    expect(themeFontFace("porsche-sage")).toMatch(/porsche-next/);
    expect(themeFontFace("default")).toBeNull();
    expect(themeFontFace(null)).toBeNull();

    expect(isPorscheTheme("porsche")).toBe(true);
    expect(isPorscheTheme("porsche-sage")).toBe(true);
    expect(isPorscheTheme("default")).toBe(false);
    expect(isPorscheTheme(null)).toBe(false);
  });
});
