import { surveyThemeVars, themeFontFace } from "../theme";

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

  test("font-face is injected only for porsche", () => {
    expect(themeFontFace("porsche")).toMatch(/@font-face/);
    expect(themeFontFace("porsche")).toMatch(/porsche-next/);
    expect(themeFontFace("default")).toBeNull();
    expect(themeFontFace(null)).toBeNull();
  });
});
