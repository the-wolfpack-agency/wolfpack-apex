/**
 * favicon-generator — unit tests for the zero-dep favicon synthesis.
 *
 * Validates:
 *   - paletteToFaviconSvg emits valid SVG containing the requested bg/fg
 *     and monogram.
 *   - briefToFaviconHref's priority: explicit URL > autoGenerate > empty.
 *   - Degenerate inputs (null brief, empty palette, bad hex) return safe
 *     fallbacks instead of throwing.
 */

import {
  briefToFaviconHref,
  paletteToFaviconSvg,
  pickContrastingForeground,
  resolveMonogram,
  resolvePrimaryColor,
} from "@/lib/favicon-generator";
import type { SiteBrief } from "@/lib/sites-schema";

const BASE_BRIEF: SiteBrief = {
  client: "acme",
  product: { name: "Acme" },
  pages: [{ route: "/", sections: [{ type: "hero", heading: "Hello" }] }],
};

describe("paletteToFaviconSvg", () => {
  it("emits a well-formed SVG with the bg + fg + monogram baked in", () => {
    const svg = paletteToFaviconSvg({
      bg: "#1f2937",
      fg: "#ffffff",
      monogram: "A",
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('fill="#1f2937"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain(">A<");
    expect(svg).toContain('viewBox="0 0 24 24"');
  });

  it("uppercases single-char monograms and keeps only the first two", () => {
    const svg = paletteToFaviconSvg({
      bg: "#000000",
      fg: "#ffffff",
      monogram: "abc",
    });
    // First two chars only
    expect(svg).toContain(">AB<");
  });

  it("falls back to a bullet when monogram is empty", () => {
    const svg = paletteToFaviconSvg({
      bg: "#000000",
      fg: "#ffffff",
      monogram: "",
    });
    expect(svg).toContain(">·<");
  });

  it("uses default colors on malformed hex", () => {
    const svg = paletteToFaviconSvg({
      bg: "not-a-color",
      fg: "also-bad",
      monogram: "X",
    });
    // Default bg is #1f2937, default fg is #ffffff
    expect(svg).toContain('fill="#1f2937"');
    expect(svg).toContain('fill="#ffffff"');
  });

  it("escapes XML-special characters in the monogram", () => {
    const svg = paletteToFaviconSvg({
      bg: "#112233",
      fg: "#ffffff",
      monogram: "<&",
    });
    // `<` and `&` must be escaped — otherwise SVG parsers reject it.
    expect(svg).not.toMatch(/>[^>]*<&/);
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&amp;");
  });
});

describe("pickContrastingForeground", () => {
  it("returns dark fg on a light bg", () => {
    expect(pickContrastingForeground("#ffffff")).toBe("#111827");
  });

  it("returns white on a dark bg", () => {
    expect(pickContrastingForeground("#000000")).toBe("#ffffff");
  });

  it("falls back to white on malformed bg", () => {
    expect(pickContrastingForeground("zzz")).toBe("#ffffff");
  });
});

describe("resolvePrimaryColor", () => {
  it("returns the nested theme.colors.primary", () => {
    expect(
      resolvePrimaryColor({
        ...BASE_BRIEF,
        theme: { colors: { primary: "#ff6600" } },
      }),
    ).toBe("#ff6600");
  });

  it("falls back to nested theme.colors.bg when primary missing", () => {
    expect(
      resolvePrimaryColor({
        ...BASE_BRIEF,
        theme: { colors: { bg: "#123456" } },
      }),
    ).toBe("#123456");
  });

  it("reads the flat legacy theme shape", () => {
    expect(
      resolvePrimaryColor({
        ...BASE_BRIEF,
        theme: { primary: "#abcdef" },
      }),
    ).toBe("#abcdef");
  });

  it("falls back to default when theme missing", () => {
    expect(resolvePrimaryColor(BASE_BRIEF)).toBe("#1f2937");
  });

  it("tolerates null brief", () => {
    expect(resolvePrimaryColor(null)).toBe("#1f2937");
  });
});

describe("resolveMonogram", () => {
  it("prefers an explicit favicon.monogram", () => {
    expect(
      resolveMonogram({
        ...BASE_BRIEF,
        favicon: { monogram: "W" },
      }),
    ).toBe("W");
  });

  it("falls back to product.name first letter", () => {
    expect(resolveMonogram(BASE_BRIEF)).toBe("A");
  });

  it("strips leading punctuation", () => {
    expect(
      resolveMonogram({
        ...BASE_BRIEF,
        product: { name: "!Wolf" },
      }),
    ).toBe("W");
  });

  it("returns empty string when no name", () => {
    expect(
      resolveMonogram({
        ...BASE_BRIEF,
        product: { name: "" },
      }),
    ).toBe("");
  });

  it("tolerates null brief", () => {
    expect(resolveMonogram(null)).toBe("");
  });
});

describe("briefToFaviconHref", () => {
  it("returns favicon.src when explicitly set (wins over autoGenerate)", () => {
    expect(
      briefToFaviconHref({
        ...BASE_BRIEF,
        favicon: { src: "https://cdn.example.com/fav.ico", autoGenerate: true },
      }),
    ).toBe("https://cdn.example.com/fav.ico");
  });

  it("generates a data URL SVG when autoGenerate is true and src is absent", () => {
    const href = briefToFaviconHref({
      ...BASE_BRIEF,
      theme: { colors: { primary: "#336699" } },
      favicon: { autoGenerate: true },
    });
    expect(href.startsWith("data:image/svg+xml;base64,")).toBe(true);
    // Decode + assert it contains the expected primary color.
    const b64 = href.slice("data:image/svg+xml;base64,".length);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain('fill="#336699"');
    expect(decoded).toContain(">A<");
  });

  it("returns empty string when no favicon config at all", () => {
    expect(briefToFaviconHref(BASE_BRIEF)).toBe("");
  });

  it("returns empty string when autoGenerate is false and no src", () => {
    expect(
      briefToFaviconHref({
        ...BASE_BRIEF,
        favicon: { autoGenerate: false },
      }),
    ).toBe("");
  });

  it("returns empty string on degenerate brief inputs", () => {
    expect(briefToFaviconHref(null)).toBe("");
    expect(briefToFaviconHref(undefined)).toBe("");
  });

  it("trims whitespace from favicon.src", () => {
    expect(
      briefToFaviconHref({
        ...BASE_BRIEF,
        favicon: { src: "  https://cdn.example.com/fav.ico  " },
      }),
    ).toBe("https://cdn.example.com/fav.ico");
  });
});
