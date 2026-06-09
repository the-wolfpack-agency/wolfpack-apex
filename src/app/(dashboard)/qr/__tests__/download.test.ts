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
import { normalizeSvgSize } from "../download";
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
