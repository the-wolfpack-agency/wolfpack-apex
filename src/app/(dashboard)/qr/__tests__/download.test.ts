/**
 * Contract tests for the QR download SVG sizing.
 *
 * Regression guard for the "svg image decode failed" bug: renderQrSvg
 * emits `<svg ... width="N" height="N">`, and the raster path used to
 * APPEND width/height, producing a tag with DUPLICATE attributes. An
 * <img> parses SVG as strict XML, so duplicates made it invalid and the
 * decode failed in every browser (PNG/JPG/PDF download all broken).
 *
 * These tests assert the sized SVG has EXACTLY ONE width and one height,
 * set to the requested size, against the real renderQrSvg output. The
 * end-to-end decode+rasterize is proven separately in a real browser
 * (tests/e2e/qr-download-reality-check.spec.ts) since jsdom cannot
 * decode SVG images or run canvas.toBlob.
 */
import { normalizeSvgSize, svgToEps } from "../download";
import { renderQrSvg } from "@/lib/qr/svg";

function openTag(svg: string): string {
  const m = svg.match(/<svg[^>]*>/);
  if (!m) throw new Error("no <svg> open tag");
  return m[0];
}
function count(tag: string, attr: "width" | "height"): number {
  return (tag.match(new RegExp(`\\b${attr}=`, "g")) || []).length;
}

describe("normalizeSvgSize", () => {
  it("produces exactly one width/height at the requested size for real renderQrSvg output", () => {
    const source = renderQrSvg("https://www.thewolfpack.agency/", { size: 192 });
    // sanity: the source really does carry its own width/height (the bug precondition)
    expect(count(openTag(source), "width")).toBe(1);

    const sized = normalizeSvgSize(source, 1024);
    const tag = openTag(sized);
    expect(count(tag, "width")).toBe(1);
    expect(count(tag, "height")).toBe(1);
    expect(tag).toContain('width="1024"');
    expect(tag).toContain('height="1024"');
    expect(tag).not.toContain('width="192"');
    expect(tag).not.toContain('height="192"');
  });

  it("preserves viewBox and namespace so the SVG stays valid", () => {
    const sized = normalizeSvgSize(renderQrSvg("x", { size: 256 }), 512);
    const tag = openTag(sized);
    expect(tag).toContain("xmlns=");
    expect(tag).toMatch(/viewBox="0 0 \d+ \d+"/);
  });

  it("is idempotent — re-sizing never accumulates duplicate attributes", () => {
    const once = normalizeSvgSize(renderQrSvg("y", { size: 192 }), 1024);
    const twice = normalizeSvgSize(once, 2048);
    const tag = openTag(twice);
    expect(count(tag, "width")).toBe(1);
    expect(count(tag, "height")).toBe(1);
    expect(tag).toContain('width="2048"');
  });

  it("adds width/height even when the source has none", () => {
    const bare = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>';
    const tag = openTag(normalizeSvgSize(bare, 1024));
    expect(count(tag, "width")).toBe(1);
    expect(count(tag, "height")).toBe(1);
  });
});

describe("svgToEps (vector EPS export)", () => {
  function darkRectCount(svg: string): number {
    return (svg.match(/<rect\b[^>]*\bx=/g) || []).length; // module rects carry x
  }

  it("emits a valid EPSF header + bounding box matching the QR side", () => {
    const svg = renderQrSvg("https://ogiam.com", { size: 256 });
    const eps = svgToEps(svg, "nick-card");
    expect(eps.startsWith("%!PS-Adobe-3.0 EPSF-3.0")).toBe(true);
    expect(eps).toContain("%%BoundingBox: 0 0 256 256");
    expect(eps).toContain("%%Title: qr-nick-card");
    expect(eps.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("draws one vector rectfill per dark module (true vector, not raster)", () => {
    const svg = renderQrSvg("https://ogiam.com", { size: 256 });
    const eps = svgToEps(svg, "x");
    const modules = darkRectCount(svg);
    expect(modules).toBeGreaterThan(0);
    // One module rectfill each, plus exactly one background rectfill.
    const fills = (eps.match(/ rectfill/g) || []).length;
    expect(fills).toBe(modules + 1);
    expect(eps).not.toContain("DCTDecode"); // no embedded raster
  });

  it("flips the Y axis (PostScript origin is bottom-left)", () => {
    // A single dark module at top-left (y=0) must land at the TOP in EPS:
    // eps y = side - y - h = 256 - 0 - 8 = 248.
    const svg = '<svg viewBox="0 0 256 256" width="256" height="256"><rect width="256" height="256" fill="#fff"/><rect x="0" y="0" width="8" height="8" fill="#000"/></svg>';
    const eps = svgToEps(svg, "x");
    expect(eps).toContain("0.000 248.000 8.000 8.000 rectfill");
  });

  it("converts the module color to a PostScript rgb triple", () => {
    const svg = '<svg viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#ffffff"/><rect x="0" y="0" width="2" height="2" fill="#1a4e8a"/></svg>';
    const eps = svgToEps(svg, "x");
    expect(eps).toContain("0.1020 0.3059 0.5412 setrgbcolor"); // 0x1a/255 0x4e/255 0x8a/255
    expect(eps).toContain("1 1 1 setrgbcolor"); // white background
  });

  it("sanitizes the slug in the title (no PostScript injection)", () => {
    const eps = svgToEps(renderQrSvg("x", { size: 64 }), "a/b (evil)\n%%Pages: 9");
    expect(eps).toContain("%%Title: qr-a-b--evil---Pages--9".slice(0, 20));
    expect(eps).not.toContain("\n%%Pages: 9");
  });

  it("is deterministic", () => {
    const svg = renderQrSvg("https://ogiam.com", { size: 128 });
    expect(svgToEps(svg, "x")).toEqual(svgToEps(svg, "x"));
  });
});
