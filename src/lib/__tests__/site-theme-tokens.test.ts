/**
 * site-theme-tokens — pure unit tests.
 *
 * Covers (Path C Phase 1 · Stream P4):
 *   - DEFAULT_* scales have the shape + values we promise downstream.
 *   - resolveThemeTokens merges partial input against defaults.
 *   - normalizeFont accepts legacy {family?: string} AND new FontStack.
 *   - themeTokensToCssVars emits every token as a --wp-* declaration.
 *   - themeTokensToCssVarObject mirrors the string output as an object.
 *   - validateBrief accepts / rejects token shapes documented in schema.
 *
 * Pure TS — no jsdom.
 */

import {
  DEFAULT_MOTION,
  DEFAULT_RADIUS,
  DEFAULT_SPACING,
  DEFAULT_TYPE_SCALE,
  DEFAULT_FONT_STACK,
  DEFAULT_COLORS,
  resolveThemeTokens,
  themeTokensToCssVars,
  themeTokensToCssVarObject,
} from "@/lib/site-theme-tokens";
import {
  BriefValidationError,
  normalizeFont,
  validateBrief,
  type SiteBrief,
  type SiteTheme,
} from "@/lib/sites-schema";

function mk(overrides: Partial<SiteBrief> = {}): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme" },
    pages: [{ route: "/", sections: [] }],
    ...overrides,
  } as SiteBrief;
}

describe("DEFAULT_* scales", () => {
  it("DEFAULT_SPACING has 6 tiers 4..48 px", () => {
    expect(DEFAULT_SPACING).toEqual({
      xs: "4px",
      sm: "8px",
      md: "16px",
      lg: "24px",
      xl: "32px",
      "2xl": "48px",
    });
  });

  it("DEFAULT_RADIUS covers 0 / 4 / 8 / 16 / 9999 px", () => {
    expect(DEFAULT_RADIUS).toEqual({
      none: "0",
      sm: "4px",
      md: "8px",
      lg: "16px",
      full: "9999px",
    });
  });

  it("DEFAULT_TYPE_SCALE spans 12/16 .. 60/72", () => {
    expect(DEFAULT_TYPE_SCALE.xs).toEqual({ fontSize: "12px", lineHeight: "16px" });
    expect(DEFAULT_TYPE_SCALE.base).toEqual({ fontSize: "16px", lineHeight: "24px" });
    expect(DEFAULT_TYPE_SCALE.display).toEqual({ fontSize: "60px", lineHeight: "72px" });
    // Every tier has both fields populated (fuels the Required<> claim).
    const tiers = Object.keys(DEFAULT_TYPE_SCALE);
    expect(tiers.length).toBe(9);
    for (const t of tiers) {
      const entry = (DEFAULT_TYPE_SCALE as Record<string, { fontSize: string; lineHeight: string }>)[t];
      expect(typeof entry.fontSize).toBe("string");
      expect(typeof entry.lineHeight).toBe("string");
    }
  });

  it("DEFAULT_MOTION uses Material standard cubic-bezier", () => {
    expect(DEFAULT_MOTION.fast).toBe("150ms");
    expect(DEFAULT_MOTION.normal).toBe("250ms");
    expect(DEFAULT_MOTION.slow).toBe("400ms");
    expect(DEFAULT_MOTION.ease).toMatch(/cubic-bezier/);
  });

  it("DEFAULT_FONT_STACK + DEFAULT_COLORS are non-empty", () => {
    expect(typeof DEFAULT_FONT_STACK.family).toBe("string");
    expect(DEFAULT_FONT_STACK.family.length).toBeGreaterThan(0);
    expect(DEFAULT_FONT_STACK.weightRegular).toBeGreaterThanOrEqual(100);
    expect(DEFAULT_FONT_STACK.weightBold).toBeLessThanOrEqual(900);
    for (const v of Object.values(DEFAULT_COLORS)) {
      expect(v).toMatch(/^#/);
    }
  });
});

describe("resolveThemeTokens", () => {
  it("returns fully populated defaults for an undefined theme", () => {
    const r = resolveThemeTokens(undefined);
    expect(r.spacing).toEqual(DEFAULT_SPACING);
    expect(r.radius).toEqual(DEFAULT_RADIUS);
    expect(r.typeScale).toEqual(DEFAULT_TYPE_SCALE);
    expect(r.motion).toEqual(DEFAULT_MOTION);
    expect(r.colors).toEqual(DEFAULT_COLORS);
    expect(r.font.family.length).toBeGreaterThan(0);
  });

  it("returns defaults for an empty theme object", () => {
    const r = resolveThemeTokens({});
    expect(r.spacing).toEqual(DEFAULT_SPACING);
  });

  it("overrides only the spacing tiers the designer set", () => {
    const r = resolveThemeTokens({ spacing: { md: "20px" } });
    expect(r.spacing.md).toBe("20px");
    expect(r.spacing.xs).toBe(DEFAULT_SPACING.xs);
    expect(r.spacing["2xl"]).toBe(DEFAULT_SPACING["2xl"]);
  });

  it("overrides only the radius tiers the designer set", () => {
    const r = resolveThemeTokens({ radius: { sm: "6px", full: "999px" } });
    expect(r.radius.sm).toBe("6px");
    expect(r.radius.full).toBe("999px");
    expect(r.radius.md).toBe(DEFAULT_RADIUS.md);
  });

  it("merges typeScale per-tier AND per-field", () => {
    // Override only fontSize at tier 'base'; lineHeight falls back to default.
    const r = resolveThemeTokens({
      typeScale: { base: { fontSize: "18px", lineHeight: "28px" } },
    });
    expect(r.typeScale.base.fontSize).toBe("18px");
    expect(r.typeScale.base.lineHeight).toBe("28px");
    expect(r.typeScale.xs).toEqual(DEFAULT_TYPE_SCALE.xs);
  });

  it("overrides motion tiers individually", () => {
    const r = resolveThemeTokens({ motion: { fast: "100ms" } });
    expect(r.motion.fast).toBe("100ms");
    expect(r.motion.slow).toBe(DEFAULT_MOTION.slow);
  });

  it("preserves custom font family + falls back to default weights", () => {
    const r = resolveThemeTokens({
      font: { family: "'MyBrand', sans-serif" },
    });
    expect(r.font.family).toBe("'MyBrand', sans-serif");
    expect(r.font.weightRegular).toBe(DEFAULT_FONT_STACK.weightRegular);
  });

  it("overrides font weights independently", () => {
    const r = resolveThemeTokens({
      font: { weightBold: 900 },
    });
    expect(r.font.weightBold).toBe(900);
    expect(r.font.weightMedium).toBe(DEFAULT_FONT_STACK.weightMedium);
  });
});

describe("normalizeFont", () => {
  it("returns {} for undefined / null / non-object", () => {
    expect(normalizeFont(undefined)).toEqual({});
    expect(normalizeFont(null as unknown as undefined)).toEqual({});
  });

  it("accepts the legacy { family?: string } shape", () => {
    const out = normalizeFont({ family: "Inter, sans-serif" });
    expect(out.family).toBe("Inter, sans-serif");
  });

  it("accepts the full FontStack shape", () => {
    const out = normalizeFont({
      family: "A",
      googleFontName: "A",
      weightRegular: 400,
      weightMedium: 500,
      weightBold: 700,
      bodyFamily: "B",
    });
    expect(out.weightBold).toBe(700);
    expect(out.bodyFamily).toBe("B");
  });

  it("returns a copy (caller mutation doesn't affect input)", () => {
    const input = { family: "X" };
    const out = normalizeFont(input);
    out.family = "Y";
    expect(input.family).toBe("X");
  });
});

describe("themeTokensToCssVars + themeTokensToCssVarObject", () => {
  const resolved = resolveThemeTokens(undefined);

  it("emits every spacing tier as a --wp-space-* var", () => {
    const css = themeTokensToCssVars(resolved);
    for (const k of Object.keys(DEFAULT_SPACING)) {
      expect(css).toContain(`--wp-space-${k}:`);
    }
  });

  it("emits every radius tier as a --wp-radius-* var", () => {
    const css = themeTokensToCssVars(resolved);
    for (const k of Object.keys(DEFAULT_RADIUS)) {
      expect(css).toContain(`--wp-radius-${k}:`);
    }
  });

  it("emits --wp-type-<tier>-size and -line for every tier", () => {
    const css = themeTokensToCssVars(resolved);
    for (const k of Object.keys(DEFAULT_TYPE_SCALE)) {
      expect(css).toContain(`--wp-type-${k}-size:`);
      expect(css).toContain(`--wp-type-${k}-line:`);
    }
  });

  it("emits motion fast/normal/slow/ease", () => {
    const css = themeTokensToCssVars(resolved);
    expect(css).toContain("--wp-motion-fast: 150ms");
    expect(css).toContain("--wp-motion-normal: 250ms");
    expect(css).toContain("--wp-motion-slow: 400ms");
    expect(css).toContain("--wp-motion-ease:");
  });

  it("emits legacy color + font-family vars alongside new tokens", () => {
    const css = themeTokensToCssVars(resolved);
    expect(css).toContain("--wp-site-primary:");
    expect(css).toContain("--wp-site-font-family:");
  });

  it("themeTokensToCssVarObject returns matching keys as an object", () => {
    const obj = themeTokensToCssVarObject(resolved);
    expect(obj["--wp-space-md"]).toBe(DEFAULT_SPACING.md);
    expect(obj["--wp-radius-full"]).toBe(DEFAULT_RADIUS.full);
    expect(obj["--wp-type-base-size"]).toBe(DEFAULT_TYPE_SCALE.base.fontSize);
    expect(obj["--wp-motion-ease"]).toBe(DEFAULT_MOTION.ease);
    expect(obj["--wp-font-weight-bold"]).toBe(String(DEFAULT_FONT_STACK.weightBold));
  });

  it("custom overrides appear in the emitted CSS", () => {
    const r = resolveThemeTokens({
      spacing: { md: "20px" },
      radius: { md: "10px" },
      typeScale: { base: { fontSize: "17px", lineHeight: "26px" } },
      motion: { fast: "100ms" },
    });
    const css = themeTokensToCssVars(r);
    expect(css).toContain("--wp-space-md: 20px");
    expect(css).toContain("--wp-radius-md: 10px");
    expect(css).toContain("--wp-type-base-size: 17px");
    expect(css).toContain("--wp-motion-fast: 100ms");
  });
});

describe("validateBrief accepts valid token shapes", () => {
  it("spacing with CSS-dimension strings validates", () => {
    const theme: SiteTheme = {
      spacing: { xs: "4px", md: "1rem", "2xl": "48px" },
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("radius with pixel + 9999px full validates", () => {
    const theme: SiteTheme = {
      radius: { none: "0", sm: "4px", full: "9999px" },
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("typeScale with unitless lineHeight validates", () => {
    const theme: SiteTheme = {
      typeScale: {
        base: { fontSize: "16px", lineHeight: "1.5" },
      },
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("motion with ms duration + cubic-bezier ease validates", () => {
    const theme: SiteTheme = {
      motion: {
        fast: "100ms",
        normal: "0.25s",
        slow: "400ms",
        ease: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("font with all weights 100..900 validates", () => {
    const theme: SiteTheme = {
      font: {
        family: "Inter, sans-serif",
        weightRegular: 400,
        weightMedium: 500,
        weightBold: 700,
        bodyFamily: "Georgia, serif",
      },
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });
});

describe("validateBrief rejects invalid token shapes", () => {
  it("rejects non-string spacing value", () => {
    const theme = { spacing: { md: 16 as unknown as string } };
    expect(() => validateBrief(mk({ theme }))).toThrow(BriefValidationError);
  });

  it("rejects a word in a motion duration (CSS requires a unit)", () => {
    const theme: SiteTheme = { motion: { fast: "fast" } };
    expect(() => validateBrief(mk({ theme }))).toThrow(BriefValidationError);
  });

  it("rejects font weight 1200 (out of 100..900)", () => {
    const theme: SiteTheme = {
      font: { weightBold: 1200 as unknown as number },
    };
    expect(() => validateBrief(mk({ theme }))).toThrow(BriefValidationError);
  });

  it("rejects typeScale fontSize that is a number", () => {
    const theme = {
      typeScale: { base: { fontSize: 16 as unknown as string, lineHeight: "1.5" } },
    };
    expect(() => validateBrief(mk({ theme: theme as SiteTheme }))).toThrow(
      BriefValidationError,
    );
  });
});
