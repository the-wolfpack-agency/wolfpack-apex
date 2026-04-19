/**
 * image-palette unit tests.
 *
 * The palette extractor is a pure function over a Uint8Array, so tests
 * stub the pixel buffer directly for deterministic assertions — no PNG
 * fixtures needed for the k-means contract. PNG decoding gets its own
 * small golden test using a hand-built minimal PNG.
 */

import { deflateSync } from "node:zlib";
import {
  decodePngToPixels,
  extractPalette,
  kmeansRgb,
  paletteToTheme,
  rgbToHex,
  hexToRgb,
  luminance,
  samplePixels,
} from "@/lib/image-palette";

/* ---------------------------- Helpers --------------------------------- */

/**
 * Build a valid 8-bit RGB PNG buffer for a given pixel grid. Each pixel
 * is [r, g, b]; the grid is `height` rows of `width` pixels.
 * Uses filter byte 0 (None) on every row.
 */
function makePng(pixels: [number, number, number][][]): Uint8Array {
  const height = pixels.length;
  const width = pixels[0]?.length ?? 0;
  const rowBytes = width * 3;

  // Raw scanlines with filter byte 0 prefix.
  const raw = Buffer.alloc((rowBytes + 1) * height);
  let off = 0;
  for (let y = 0; y < height; y++) {
    raw[off++] = 0; // filter
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixels[y][x];
      raw[off++] = r;
      raw[off++] = g;
      raw[off++] = b;
    }
  }

  const idat = deflateSync(raw);

  const chunks: Buffer[] = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  chunks.push(sig);

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    // CRC not validated by our decoder; placeholder zero.
    const crc = Buffer.alloc(4);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace
  chunks.push(chunk("IHDR", ihdr));

  chunks.push(chunk("IDAT", idat));
  chunks.push(chunk("IEND", Buffer.alloc(0)));

  return new Uint8Array(Buffer.concat(chunks));
}

/* --------------------------- Primitive helpers ------------------------ */

describe("rgbToHex / hexToRgb", () => {
  it("round-trips a known colour", () => {
    expect(rgbToHex(18, 52, 86)).toBe("#123456");
    expect(hexToRgb("#123456")).toEqual([18, 52, 86]);
  });
  it("clamps out-of-range values", () => {
    expect(rgbToHex(300, -10, 128)).toBe("#ff0080");
  });
  it("returns null on malformed hex", () => {
    expect(hexToRgb("not-a-colour")).toBeNull();
    expect(hexToRgb("#abc")).toBeNull();
  });
});

describe("luminance", () => {
  it("orders black < grey < white", () => {
    const black = luminance(0, 0, 0);
    const grey = luminance(128, 128, 128);
    const white = luminance(255, 255, 255);
    expect(black).toBeLessThan(grey);
    expect(grey).toBeLessThan(white);
  });
});

/* ----------------------------- k-means -------------------------------- */

describe("kmeansRgb", () => {
  it("collapses to 1 cluster when all pixels are the same colour", () => {
    const samples: number[][] = Array.from({ length: 50 }, () => [200, 100, 50]);
    const clusters = kmeansRgb(samples, 5);
    expect(clusters.length).toBeGreaterThan(0);
    // Largest cluster centroid should match the input colour exactly.
    const top = clusters[0];
    expect(Math.round(top.centroid[0])).toBe(200);
    expect(Math.round(top.centroid[1])).toBe(100);
    expect(Math.round(top.centroid[2])).toBe(50);
    // And it absorbs nearly all samples.
    expect(top.size).toBe(50);
  });

  it("produces deterministic ordering for a 3-colour sample set", () => {
    const reds = Array.from({ length: 30 }, () => [220, 30, 30] as number[]);
    const greens = Array.from({ length: 20 }, () => [30, 200, 30] as number[]);
    const blues = Array.from({ length: 10 }, () => [30, 30, 220] as number[]);
    const samples = [...reds, ...greens, ...blues];

    const runA = kmeansRgb(samples, 3, 10);
    const runB = kmeansRgb(samples, 3, 10);

    // Same input → same output, ordered by cluster size desc.
    expect(runA.map((c) => c.size)).toEqual(runB.map((c) => c.size));
    expect(runA[0].size).toBeGreaterThanOrEqual(runA[1].size);
    expect(runA[1].size).toBeGreaterThanOrEqual(runA[2].size);
    // Biggest cluster should correspond to reds.
    expect(runA[0].centroid[0]).toBeGreaterThan(runA[0].centroid[1]);
    expect(runA[0].centroid[0]).toBeGreaterThan(runA[0].centroid[2]);
  });

  it("handles fewer samples than k without crashing", () => {
    const samples = [
      [10, 10, 10],
      [200, 200, 200],
    ];
    const clusters = kmeansRgb(samples, 5, 10);
    expect(clusters.length).toBeLessThanOrEqual(2);
  });

  it("handles empty samples", () => {
    expect(kmeansRgb([], 5)).toEqual([]);
  });
});

/* ---------------------------- samplePixels --------------------------- */

describe("samplePixels", () => {
  it("returns at most maxSamples pixels, evenly strided", () => {
    const width = 100;
    const height = 100;
    const pixels = new Uint8Array(width * height * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = 10;
      pixels[i + 1] = 20;
      pixels[i + 2] = 30;
    }
    const out = samplePixels({ width, height, pixels }, 100);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0]).toEqual([10, 20, 30]);
  });

  it("handles a single-pixel buffer", () => {
    const pixels = new Uint8Array([42, 99, 128]);
    const out = samplePixels({ width: 1, height: 1, pixels }, 4096);
    expect(out).toEqual([[42, 99, 128]]);
  });
});

/* -------------------------- PNG decode + extract --------------------- */

describe("decodePngToPixels", () => {
  it("decodes a 2x2 solid-red PNG", () => {
    const red: [number, number, number] = [255, 0, 0];
    const png = makePng([
      [red, red],
      [red, red],
    ]);
    const out = decodePngToPixels(png);
    expect(out).not.toBeNull();
    expect(out!.width).toBe(2);
    expect(out!.height).toBe(2);
    expect(Array.from(out!.pixels.slice(0, 3))).toEqual([255, 0, 0]);
  });

  it("returns null for non-PNG bytes", () => {
    const bogus = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(decodePngToPixels(bogus)).toBeNull();
  });

  it("decodes a 3x1 gradient PNG with distinct colours", () => {
    const png = makePng([
      [
        [10, 10, 10],
        [120, 120, 120],
        [240, 240, 240],
      ],
    ]);
    const out = decodePngToPixels(png);
    expect(out).not.toBeNull();
    expect(out!.width).toBe(3);
    expect(Array.from(out!.pixels)).toEqual([
      10, 10, 10, 120, 120, 120, 240, 240, 240,
    ]);
  });
});

describe("extractPalette", () => {
  it("returns an empty palette for undecodable bytes (JPEG stub etc.)", () => {
    const p = extractPalette(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(p.swatches).toEqual([]);
    expect(p.weights).toEqual([]);
  });

  it("pulls dominant colour from a PNG of mostly one colour", () => {
    // 10x10 buffer: 90 red + 10 blue pixels.
    const red: [number, number, number] = [220, 30, 30];
    const blue: [number, number, number] = [30, 30, 220];
    const pixels: [number, number, number][][] = [];
    for (let y = 0; y < 10; y++) {
      const row: [number, number, number][] = [];
      for (let x = 0; x < 10; x++) {
        row.push(y === 0 ? blue : red);
      }
      pixels.push(row);
    }
    const png = makePng(pixels);
    const palette = extractPalette(png, 3);
    expect(palette.swatches.length).toBeGreaterThan(0);
    const [topR, topG, topB] = hexToRgb(palette.swatches[0]) ?? [0, 0, 0];
    expect(topR).toBeGreaterThan(topG);
    expect(topR).toBeGreaterThan(topB);
    // weights sum to ~1
    const sum = palette.weights.reduce((n, w) => n + w, 0);
    expect(sum).toBeGreaterThan(0.95);
    expect(sum).toBeLessThanOrEqual(1.0001);
  });
});

describe("paletteToTheme", () => {
  it("returns a neutral default for an empty palette", () => {
    const theme = paletteToTheme({ swatches: [], weights: [] });
    expect(theme.primary).toMatch(/^#[0-9a-f]{6}$/i);
    expect(theme.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(theme.bg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(theme.fg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(theme.muted).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("assigns primary=first, accent=second swatch", () => {
    const theme = paletteToTheme({
      swatches: ["#aa0000", "#00aa00", "#0000aa", "#ffffff", "#000000"],
      weights: [0.5, 0.2, 0.15, 0.1, 0.05],
    });
    expect(theme.primary).toBe("#aa0000");
    expect(theme.accent).toBe("#00aa00");
    expect(theme.bg).toBe("#000000");
    expect(theme.fg).toBe("#ffffff");
  });

  it("falls back accent → primary when only 1 swatch exists", () => {
    const theme = paletteToTheme({
      swatches: ["#123456"],
      weights: [1],
    });
    expect(theme.primary).toBe("#123456");
    expect(theme.accent).toBe("#123456");
  });

  it("assigns bg to the darkest and fg to the brightest regardless of order", () => {
    const theme = paletteToTheme({
      swatches: ["#808080", "#ffffff", "#000000", "#c0c0c0", "#404040"],
      weights: [0.3, 0.25, 0.2, 0.15, 0.1],
    });
    expect(theme.bg).toBe("#000000");
    expect(theme.fg).toBe("#ffffff");
  });
});
