/** extractPaletteAsync: JPEG mock-ups get a DETERMINISTIC palette via guarded
 *  sharp, and ANY sharp failure degrades to an empty palette (never throws,
 *  never blanks). PNG stays on the pure-JS path. */
import sharp from "sharp";
import { extractPaletteAsync } from "../image-palette";

const near = (hex: string, r: number, g: number, b: number, tol = 40) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return Math.abs(((n >> 16) & 0xff) - r) < tol && Math.abs(((n >> 8) & 0xff) - g) < tol && Math.abs((n & 0xff) - b) < tol;
};

describe("extractPaletteAsync", () => {
  it("extracts a deterministic palette from a JPEG (the designer's FOR_REVIEW case)", async () => {
    const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
    const palette = await extractPaletteAsync(new Uint8Array(jpeg));
    expect(palette.swatches.length).toBeGreaterThan(0);
    // The dominant swatch is the red we painted (JPEG is lossy -> wide tolerance).
    expect(palette.swatches.some((s) => near(s, 200, 30, 30))).toBe(true);
  });

  it("extracts from a PNG via the pure-JS fast path (no sharp needed)", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 20, g: 120, b: 220 } } }).png().toBuffer();
    const palette = await extractPaletteAsync(new Uint8Array(png));
    expect(palette.swatches.length).toBeGreaterThan(0);
  });

  it("degrades to an empty palette on undecodable bytes - never throws (fail-safe)", async () => {
    const palette = await extractPaletteAsync(new Uint8Array([1, 2, 3, 4, 5]));
    expect(palette).toEqual({ swatches: [], weights: [] });
  });
});
