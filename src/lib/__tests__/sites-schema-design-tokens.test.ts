/**
 * sites-schema — design-token regression tests (Path C Phase 1 · P4).
 *
 * Anchors the backward-compat invariant: EVERY brief that validated
 * before the design-token expansion must still validate. Briefs that
 * adopt partial tokens must validate. Briefs with invalid token values
 * must throw. No field is required.
 */

import {
  BriefValidationError,
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

describe("backward compat — briefs without design tokens", () => {
  it("brief with no theme still validates", () => {
    expect(() => validateBrief(mk())).not.toThrow();
  });

  it("brief with only legacy color theme still validates", () => {
    const theme: SiteTheme = {
      colors: { primary: "#112233", accent: "#aabbcc" },
      font: { family: "'Inter', sans-serif" },
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("brief with legacy flat Record<string,string> theme still validates", () => {
    // Pre-P4 briefs sometimes stored theme as a flat map. The schema
    // accepts both shapes so existing DB rows never reject on load.
    expect(() =>
      validateBrief(mk({ theme: { primary: "#112233", font: "Inter" } })),
    ).not.toThrow();
  });

  it("brief with legacy font string (flat form) still validates", () => {
    expect(() =>
      validateBrief(
        mk({
          theme: { font: "Inter" } as unknown as SiteTheme,
        }),
      ),
    ).not.toThrow();
  });
});

describe("partial token adoption", () => {
  it("brief with only spacing set validates", () => {
    const theme: SiteTheme = { spacing: { md: "20px" } };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("brief with only radius set validates", () => {
    const theme: SiteTheme = { radius: { full: "999px" } };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("brief with only typeScale set validates", () => {
    const theme: SiteTheme = {
      typeScale: { display: { fontSize: "72px", lineHeight: "80px" } },
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("brief with only motion set validates", () => {
    const theme: SiteTheme = { motion: { fast: "120ms" } };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });

  it("brief with ALL new scales set to empty objects validates", () => {
    const theme: SiteTheme = {
      spacing: {},
      radius: {},
      typeScale: {},
      motion: {},
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });
});

describe("rejects invalid token shapes", () => {
  it("rejects numeric spacing value (must be CSS string)", () => {
    const theme = { spacing: { md: 16 as unknown as string } };
    expect(() => validateBrief(mk({ theme }))).toThrow(BriefValidationError);
  });

  it('rejects motion "fast" keyword as a duration (needs ms/s)', () => {
    expect(() =>
      validateBrief(mk({ theme: { motion: { fast: "fast" } } })),
    ).toThrow(BriefValidationError);
  });

  it("rejects font weight 1200 (outside 100..900)", () => {
    expect(() =>
      validateBrief(
        mk({ theme: { font: { weightBold: 1200 as unknown as number } } }),
      ),
    ).toThrow(BriefValidationError);
  });

  it("rejects font weight 50 (below the 100 floor)", () => {
    expect(() =>
      validateBrief(
        mk({ theme: { font: { weightRegular: 50 as unknown as number } } }),
      ),
    ).toThrow(BriefValidationError);
  });

  it("rejects typeScale entry missing lineHeight", () => {
    expect(() =>
      validateBrief(
        mk({
          theme: {
            typeScale: {
              base: { fontSize: "16px" } as unknown as {
                fontSize: string;
                lineHeight: string;
              },
            },
          },
        }),
      ),
    ).toThrow(BriefValidationError);
  });

  it("rejects radius with bogus value (non-string)", () => {
    const theme = {
      radius: { full: true as unknown as string },
    };
    expect(() => validateBrief(mk({ theme }))).toThrow(BriefValidationError);
  });

  it('rejects motion.ease that is not a valid CSS easing', () => {
    expect(() =>
      validateBrief(
        mk({ theme: { motion: { ease: "bouncy" } } }),
      ),
    ).toThrow(BriefValidationError);
  });

  it("rejects spacing array instead of object", () => {
    const theme = { spacing: ["8px"] as unknown as Record<string, string> };
    expect(() =>
      validateBrief(mk({ theme: theme as unknown as SiteTheme })),
    ).toThrow(BriefValidationError);
  });
});

describe("accepts full token suite plus colors/font together", () => {
  it("fully populated theme with every new field validates", () => {
    const theme: SiteTheme = {
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
        weightRegular: 400,
        weightMedium: 500,
        weightBold: 700,
        bodyFamily: "'Source Serif Pro', serif",
      },
      spacing: {
        xs: "4px",
        sm: "8px",
        md: "16px",
        lg: "24px",
        xl: "32px",
        "2xl": "48px",
      },
      radius: {
        none: "0",
        sm: "4px",
        md: "8px",
        lg: "16px",
        full: "9999px",
      },
      typeScale: {
        xs: { fontSize: "12px", lineHeight: "16px" },
        base: { fontSize: "16px", lineHeight: "1.5" },
        display: { fontSize: "60px", lineHeight: "72px" },
      },
      motion: {
        fast: "150ms",
        normal: "0.25s",
        slow: "400ms",
        ease: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
    };
    expect(() => validateBrief(mk({ theme }))).not.toThrow();
  });
});
