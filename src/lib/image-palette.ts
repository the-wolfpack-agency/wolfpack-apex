/**
 * image-palette — pure-JS dominant color extraction, no new deps.
 *
 * Why not sharp/jimp: we do not want to take a new runtime dependency
 * just to pull ~5 colors out of a wireframe. All we need is a set of
 * RGB samples; k-means is arithmetic. PNG + JPEG decoders are already
 * reachable through the Node `zlib` stdlib (PNG) and raw marker parsing
 * (JPEG) — but to keep this file small and dependency-free we stick
 * to PNG decoding only (which covers the overwhelming majority of
 * wireframe exports from Figma, Excalidraw, etc.) and fall back to a
 * uniform-grey palette if we cannot decode. That fallback lets the
 * orchestrator keep moving — the Claude vision call still produces a
 * valid brief, we just skip the palette-derived theme. Every decode
 * outcome is reported so the learning loop can trend decode-success
 * rates.
 *
 * No new runtime dependency is introduced; this is why we refuse JPEG
 * decoding in this first cut. If a JPEG lands, `decodeImageToPixels`
 * returns null and `extractPalette` returns an empty array; callers
 * must tolerate that.
 */

import { inflateSync } from "node:zlib";

export interface PixelBuffer {
  width: number;
  height: number;
  // Flat RGB array, length = width * height * 3. Alpha stripped.
  pixels: Uint8Array;
}

export interface Palette {
  /** Hex strings (lowercase `#rrggbb`), ordered by descending cluster size. */
  swatches: string[];
  /** Per-swatch pixel share in [0, 1]. Parallel to `swatches`. */
  weights: number[];
}

export interface ThemeColors {
  primary: string;
  accent: string;
  bg: string;
  fg: string;
  muted: string;
}

/* ------------------------- Hex + colour helpers ----------------------- */

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => clamp255(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG-esque luminance (0..1). Cheap, deterministic, good enough for
 *  "brightest vs darkest" ordering. */
export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/* ----------------------------- PNG decoder ---------------------------- */

// RFC 2083 minimal subset: 8-bit-depth, colour types 2 (RGB) and 6
// (RGBA), filter method 0, no interlace. Covers Figma/Canva/Excalidraw
// exports, which are the wireframe sources we care about.

function readUInt32BE(buf: Uint8Array, off: number): number {
  return (
    (buf[off] * 0x1000000) +
    (buf[off + 1] << 16) +
    (buf[off + 2] << 8) +
    buf[off + 3]
  );
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG into a packed RGB pixel buffer. Returns null for
 * unsupported PNG variants (interlaced, palette-indexed, 16-bit, etc.)
 * so callers can treat it as "could not decode, skip palette".
 */
export function decodePngToPixels(buf: Uint8Array): PixelBuffer | null {
  if (!isPng(buf)) return null;

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Uint8Array[] = [];

  while (off < buf.length) {
    if (off + 8 > buf.length) return null;
    const len = readUInt32BE(buf, off);
    const type = String.fromCharCode(
      buf[off + 4],
      buf[off + 5],
      buf[off + 6],
      buf[off + 7],
    );
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return null;

    if (type === "IHDR") {
      width = readUInt32BE(buf, dataStart);
      height = readUInt32BE(buf, dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === "IDAT") {
      idatParts.push(buf.slice(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }

    off = dataEnd + 4; // skip CRC
  }

  if (!width || !height) return null;
  if (bitDepth !== 8) return null;
  if (interlace !== 0) return null;
  // Support truecolour (2) and truecolour+alpha (6) only. Greyscale / paletted
  // images are rare in design wireframes we actually want to palette.
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) return null;

  const compressed = Buffer.concat(idatParts.map((p) => Buffer.from(p)));
  let raw: Buffer;
  try {
    raw = inflateSync(compressed);
  } catch {
    return null;
  }

  const rowBytes = width * channels;
  const expectedRawLen = (rowBytes + 1) * height;
  if (raw.length < expectedRawLen) return null;

  const pixels = new Uint8Array(width * height * 3);
  const prevRow = new Uint8Array(rowBytes);
  const curRow = new Uint8Array(rowBytes);

  let src = 0;
  let dst = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    // Reset curRow to zero for this scanline; defiltering writes to it.
    for (let i = 0; i < rowBytes; i++) curRow[i] = 0;
    for (let x = 0; x < rowBytes; x++) {
      const byte = raw[src++];
      const left = x >= channels ? curRow[x - channels] : 0;
      const up = prevRow[x];
      const upLeft = x >= channels ? prevRow[x - channels] : 0;
      let val = 0;
      switch (filter) {
        case 0: val = byte; break;
        case 1: val = (byte + left) & 0xff; break;
        case 2: val = (byte + up) & 0xff; break;
        case 3: val = (byte + ((left + up) >> 1)) & 0xff; break;
        case 4: val = (byte + paethPredictor(left, up, upLeft)) & 0xff; break;
        default: return null;
      }
      curRow[x] = val;
    }
    // Copy the RGB (strip alpha if any).
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      pixels[dst++] = curRow[si];
      pixels[dst++] = curRow[si + 1];
      pixels[dst++] = curRow[si + 2];
    }
    // prevRow = curRow for next scanline
    prevRow.set(curRow);
  }

  return { width, height, pixels };
}

/**
 * Best-effort decode dispatcher. PNG only for the first cut — JPEG/WEBP
 * fall through to `null`, which signals callers to skip the palette and
 * let the vision model supply theme hints instead.
 */
export function decodeImageToPixels(buf: Uint8Array): PixelBuffer | null {
  return decodePngToPixels(buf);
}

/* ------------------------------ k-means ------------------------------- */

/**
 * Evenly sample at most `maxSamples` pixels from the buffer. Deterministic
 * (no RNG) so tests can lock exact output.
 */
export function samplePixels(
  buf: PixelBuffer,
  maxSamples = 4096,
): number[][] {
  const total = buf.width * buf.height;
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const out: number[][] = [];
  for (let i = 0; i < total; i += stride) {
    const off = i * 3;
    out.push([buf.pixels[off], buf.pixels[off + 1], buf.pixels[off + 2]]);
    if (out.length >= maxSamples) break;
  }
  return out;
}

function seededStep(seed: number): number {
  // Mulberry32 — small, deterministic, good enough for centroid seeding.
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function pickInitialCentroids(samples: number[][], k: number): number[][] {
  // k-means++ style spread, but seeded so tests are reproducible.
  if (samples.length <= k) {
    return samples.slice(0, k).map((s) => [...s]);
  }
  const centroids: number[][] = [];
  // Seed first centroid deterministically — index derived from length.
  const first = Math.floor(seededStep(samples.length) * samples.length);
  centroids.push([...samples[first]]);
  for (let c = 1; c < k; c++) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < samples.length; i++) {
      // Distance to nearest existing centroid.
      let minD = Infinity;
      for (const cent of centroids) {
        const dr = samples[i][0] - cent[0];
        const dg = samples[i][1] - cent[1];
        const db = samples[i][2] - cent[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < minD) minD = d;
      }
      if (minD > bestDist) {
        bestDist = minD;
        bestIdx = i;
      }
    }
    centroids.push([...samples[bestIdx]]);
  }
  return centroids;
}

/**
 * Run k-means in RGB space. Returns centroids + sizes sorted by size
 * (largest cluster first).
 */
export function kmeansRgb(
  samples: number[][],
  k = 5,
  iterations = 10,
): { centroid: number[]; size: number }[] {
  if (samples.length === 0) return [];
  const effectiveK = Math.min(k, samples.length);
  const centroids = pickInitialCentroids(samples, effectiveK);
  const assignments = new Int32Array(samples.length);

  for (let iter = 0; iter < iterations; iter++) {
    // Assign
    for (let i = 0; i < samples.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dr = samples[i][0] - centroids[c][0];
        const dg = samples[i][1] - centroids[c][1];
        const db = samples[i][2] - centroids[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assignments[i] = best;
    }
    // Update
    const sums = Array.from({ length: centroids.length }, () => [0, 0, 0]);
    const counts = new Int32Array(centroids.length);
    for (let i = 0; i < samples.length; i++) {
      const a = assignments[i];
      sums[a][0] += samples[i][0];
      sums[a][1] += samples[i][1];
      sums[a][2] += samples[i][2];
      counts[a]++;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue;
      centroids[c][0] = sums[c][0] / counts[c];
      centroids[c][1] = sums[c][1] / counts[c];
      centroids[c][2] = sums[c][2] / counts[c];
    }
  }

  // Final count after the last assignment pass.
  const finalCounts = new Int32Array(centroids.length);
  for (let i = 0; i < samples.length; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const dr = samples[i][0] - centroids[c][0];
      const dg = samples[i][1] - centroids[c][1];
      const db = samples[i][2] - centroids[c][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    finalCounts[best]++;
  }

  return centroids
    .map((c, i) => ({ centroid: c, size: finalCounts[i] }))
    .sort((a, b) => b.size - a.size);
}

/* ----------------------------- Public API ----------------------------- */

/**
 * Extract up to `count` dominant colours from a raw image buffer.
 *
 * Returns `{ swatches: [], weights: [] }` when the buffer cannot be
 * decoded (e.g. JPEG, WEBP, or a malformed PNG). Callers should treat
 * empty palettes as "model-only theme hints" and still continue.
 */
export function extractPalette(
  buf: Uint8Array | Buffer,
  count = 5,
): Palette {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const pixels = decodeImageToPixels(u8);
  if (!pixels || pixels.pixels.length === 0) {
    return { swatches: [], weights: [] };
  }
  const samples = samplePixels(pixels, 4096);
  if (samples.length === 0) return { swatches: [], weights: [] };
  const clusters = kmeansRgb(samples, count, 10);
  const total = clusters.reduce((n, c) => n + c.size, 0) || 1;
  return {
    swatches: clusters.map((c) =>
      rgbToHex(c.centroid[0], c.centroid[1], c.centroid[2]),
    ),
    weights: clusters.map((c) => c.size / total),
  };
}

/**
 * Palette → named theme colors, matching `SiteThemeColors`:
 *   primary = largest cluster
 *   accent  = second largest (fallback: primary)
 *   bg      = darkest cluster
 *   fg      = brightest cluster
 *   muted   = middle-luminance cluster
 *
 * When the palette is empty, returns a neutral greyscale default. That
 * keeps downstream consumers happy without forcing them to special-case
 * "no palette".
 */
export function paletteToTheme(palette: Palette): ThemeColors {
  if (palette.swatches.length === 0) {
    return {
      primary: "#1f2937",
      accent: "#6366f1",
      bg: "#0b1220",
      fg: "#f9fafb",
      muted: "#9ca3af",
    };
  }

  // Sort swatches by luminance once to pick darkest / brightest / middle.
  const withLum = palette.swatches.map((hex, i) => {
    const rgb = hexToRgb(hex) ?? [0, 0, 0];
    return { hex, lum: luminance(rgb[0], rgb[1], rgb[2]), idx: i };
  });
  const byLum = [...withLum].sort((a, b) => a.lum - b.lum);
  const darkest = byLum[0].hex;
  const brightest = byLum[byLum.length - 1].hex;
  const middle = byLum[Math.floor(byLum.length / 2)].hex;

  const primary = palette.swatches[0];
  const accent = palette.swatches[1] ?? palette.swatches[0];

  return {
    primary,
    accent,
    bg: darkest,
    fg: brightest,
    muted: middle,
  };
}
